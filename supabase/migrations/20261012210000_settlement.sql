-- Nightly settlement (CLAUDE.md money rule 6).
--
-- At 12:00 Lagos, every closed, unsettled night gets one payout row per payee
-- (the club, and each DJ/MC who earned), straight from
-- night_settlement_amounts (refunds already reversed; unassigned shares never
-- included; the platform keeps its share). A payee without a payable payout
-- account is `held` and released automatically once they're verified.
--
-- The payout worker (/api/jobs/payouts) then moves each payout in two hops:
--   pending      -> transfer platform balance -> their Connect account
--   transferred  -> payout their account -> their default bank account,
--                   amount minus the payout fee (taken from the payee)
--   processing   -> payout.paid / payout.failed webhooks -> paid / failed

alter table public.payouts
  drop constraint payouts_venue_night_id_party_key,
  add column payout_account_id uuid references public.payout_accounts (id),
  add column provider_transfer_id text,
  add column fee numeric(14, 2),
  add column held_reason text check (
    held_reason in ('no_payout_account', 'payout_account_not_ready', 'no_bank_account', 'below_minimum')
  ),
  add column attempts integer not null default 0,
  -- A minute's grace before the background worker first picks it up.
  add column next_attempt_at timestamptz not null default now() + interval '1 minute',
  add column last_error text,
  add column paid_at timestamptz;

-- One payout per payee per night (several DJs can earn in one night).
create unique index payouts_one_per_payee_per_night
  on public.payouts (venue_night_id, party, coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index payouts_due_idx on public.payouts (next_attempt_at) where status in ('pending', 'transferred');

-- Bachs's bank payout fee, charged on top of the payout and taken from the
-- payee's share (CLAUDE.md). NGN: 50.00 flat.
create function public.payout_fee(p_currency text)
returns numeric(14, 2)
language sql
immutable
set search_path = ''
as $$
  select case p_currency when 'NGN' then 50.00 else null end::numeric(14, 2);
$$;

-- Smallest share worth paying out: it must leave something after the fee.
create function public.payout_minimum(p_currency text)
returns numeric(14, 2)
language sql
immutable
set search_path = ''
as $$
  select case p_currency when 'NGN' then 100.00 else null end::numeric(14, 2);
$$;

create function public.payee_account(p_venue_id uuid, p_party public.ledger_party, p_profile_id uuid)
returns public.payout_accounts
language sql
stable
security definer
set search_path = ''
as $$
  select a.* from public.payout_accounts a
  where a.provider = 'bachs'
    and case when p_party = 'club' then a.venue_id = p_venue_id else a.profile_id = p_profile_id end;
$$;

-- Creates the night's payouts. Idempotent; refuses open or already-settled nights.
create function public.settle_night(p_night_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_night public.venue_nights%rowtype;
  v_due record;
  v_account public.payout_accounts;
  v_reason text;
  v_count integer := 0;
  v_id uuid;
begin
  select * into v_night from public.venue_nights where id = p_night_id for update;
  if not found then
    raise exception 'night % not found', p_night_id using errcode = 'P0002';
  end if;
  if v_night.closed_at is null then
    raise exception 'night % is still open', p_night_id using errcode = '22023';
  end if;
  if v_night.settled_at is not null then
    return 0;
  end if;

  for v_due in select * from public.night_settlement_amounts(p_night_id) loop
    v_account := public.payee_account(v_night.venue_id, v_due.party, v_due.profile_id);
    v_reason := case
      when v_account.id is null then 'no_payout_account'
      when v_account.status <> 'active' then 'payout_account_not_ready'
      when v_due.amount < public.payout_minimum(v_due.currency) then 'below_minimum'
    end;
    v_id := gen_random_uuid();
    insert into public.payouts (
      id, venue_id, venue_night_id, party, profile_id, amount, currency, provider, idempotency_key,
      status, payout_account_id, held_reason
    ) values (
      v_id, v_night.venue_id, p_night_id, v_due.party, v_due.profile_id, v_due.amount, v_due.currency, 'bachs',
      'settle_' || v_id,
      case when v_reason is null then 'pending' else 'held' end::public.payout_status,
      v_account.id, v_reason
    )
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  update public.venue_nights set settled_at = now() where id = p_night_id;
  return v_count;
end;
$$;

-- Held payouts whose payee is now payable go back into the queue: to
-- `transferred` if the money already reached their account, else `pending`.
create function public.release_held_payouts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.payouts p
  set status = case when p.provider_transfer_id is not null then 'transferred' else 'pending' end::public.payout_status,
      held_reason = null,
      payout_account_id = a.id,
      next_attempt_at = now(),
      updated_at = now()
  from public.payout_accounts a
  where p.status = 'held'
    and p.held_reason in ('no_payout_account', 'payout_account_not_ready', 'no_bank_account')
    and a.status = 'active'
    and a.id = (public.payee_account(p.venue_id, p.party, p.profile_id)).id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Daily at 12:00 Lagos: settle every closed night, then release held payouts.
create function public.settle_closed_nights()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_night_id uuid;
  v_count integer := 0;
begin
  for v_night_id in
    select id from public.venue_nights where closed_at is not null and settled_at is null order by closed_at
  loop
    perform public.settle_night(v_night_id);
    v_count := v_count + 1;
  end loop;
  perform public.release_held_payouts();
  return v_count;
end;
$$;

-- Payouts the worker should move now, leased for 2 minutes. p_payout_id
-- claims one payout immediately (admin "retry now", tests).
create function public.claim_due_payouts(p_limit integer default 20, p_payout_id uuid default null)
returns table (
  id uuid,
  status public.payout_status,
  venue_night_id uuid,
  amount text,
  net_amount text,
  currency text,
  recipient_id text,
  attempts integer
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select p.id from public.payouts p
    where p.status in ('pending', 'transferred')
      and (p.id = p_payout_id or (p_payout_id is null and p.next_attempt_at <= now()))
    order by p.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  leased as (
    update public.payouts p
    set next_attempt_at = now() + interval '2 minutes', attempts = p.attempts + 1, updated_at = now()
    from due where p.id = due.id
    returning p.*
  )
  select l.id, l.status, l.venue_night_id, l.amount::text, (l.amount - public.payout_fee(l.currency))::text,
    l.currency, a.recipient_id, l.attempts
  from leased l
  join public.payout_accounts a on a.id = l.payout_account_id;
$$;

-- payout.paid / payout.failed. Final states are sticky.
create function public.record_payout_result(
  p_provider text,
  p_provider_payout_id text,
  p_reference uuid,
  p_status public.payout_status,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payouts
  set status = p_status,
      last_error = p_error,
      paid_at = case when p_status = 'paid' then now() else paid_at end,
      updated_at = now()
  where provider = p_provider
    and (provider_payout_id = p_provider_payout_id or id = p_reference)
    and status not in ('paid', 'failed');
  return found;
end;
$$;

create function public.kick_payout_worker()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'app_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  if not exists (
    select 1 from public.payouts where status in ('pending', 'transferred') and next_attempt_at <= now()
  ) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/api/jobs/payouts',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

-- When a payout account becomes payable, release its held payouts right away
-- rather than waiting for the next noon run.
create function public.release_on_account_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status <> 'active' then
    perform public.release_held_payouts();
  end if;
  return null;
end;
$$;

create trigger payout_accounts_release_held
  after update of status on public.payout_accounts
  for each row execute function public.release_on_account_active();

revoke execute on function public.payee_account(uuid, public.ledger_party, uuid) from public, anon, authenticated;
revoke execute on function public.settle_night(uuid) from public, anon, authenticated;
revoke execute on function public.release_held_payouts() from public, anon, authenticated;
revoke execute on function public.settle_closed_nights() from public, anon, authenticated;
revoke execute on function public.claim_due_payouts(integer, uuid) from public, anon, authenticated;
revoke execute on function public.record_payout_result(text, text, uuid, public.payout_status, text) from public, anon, authenticated;
revoke execute on function public.kick_payout_worker() from public, anon, authenticated;
grant execute on function public.settle_night(uuid) to service_role;
grant execute on function public.claim_due_payouts(integer, uuid) to service_role;
grant execute on function public.record_payout_result(text, text, uuid, public.payout_status, text) to service_role;

select cron.schedule('settle-closed-nights', '0 11 * * *', 'select public.settle_closed_nights()');
select cron.schedule('kick-payout-worker', '* * * * *', 'select public.kick_payout_worker()');

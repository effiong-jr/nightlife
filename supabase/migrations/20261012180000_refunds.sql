-- Refunds (CLAUDE.md money rules 6 and 12, product rule on song timeouts).
--
-- Flow: an order becomes `rejected` (staff, song-request timeout, or a late
-- payment on an expired order) -> request_refund() creates a `pending` refund
-- and writes the ledger reversals in the same transaction (so settlement can
-- never pay out money that's going back) -> the refund worker
-- (/api/jobs/refunds) sends it to the provider -> refund webhooks record the
-- outcome. Failed refunds stay `failed` with an error for admin review.
--
-- Over/underpayments are NOT auto-refunded: a payment can only be refunded
-- once, so they stay flagged in webhook_events for review.

alter type public.refund_status add value 'processing' before 'succeeded';

alter table public.refunds
  drop constraint refunds_order_id_key,
  add column attempts integer not null default 0,
  -- A minute's grace before the first send (and before the background worker
  -- can pick it up).
  add column next_attempt_at timestamptz not null default now() + interval '1 minute',
  add column last_error text,
  drop constraint refunds_reason_check,
  add constraint refunds_reason_check
    check (reason in ('rejected_by_staff', 'request_timeout', 'late_payment', 'admin'));

-- One live refund per order; a failed one can be retried with a new row.
create unique index refunds_one_live_per_order on public.refunds (order_id) where status <> 'failed';
create index refunds_due_idx on public.refunds (next_attempt_at) where status = 'pending';

-- Creates the refund and its ledger reversals. Idempotent per order.
create function public.request_refund(p_order_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_refund_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.paid_at is null then
    raise exception 'order % was never paid', p_order_id using errcode = '22023';
  end if;

  select id into v_refund_id from public.refunds where order_id = p_order_id and status <> 'failed';
  if found then
    return v_refund_id;
  end if;

  select * into v_payment from public.payments
  where order_id = p_order_id and status = 'succeeded';

  v_refund_id := gen_random_uuid();
  insert into public.refunds (id, venue_id, order_id, provider, idempotency_key, amount, currency, reason)
  values (
    v_refund_id, v_order.venue_id, v_order.id, coalesce(v_payment.provider, 'bachs'),
    'refund_' || v_refund_id, v_order.amount, v_order.currency, p_reason
  );

  -- Reverse every share (assigned or not). One reversal per party per order,
  -- so a retried refund after a failure doesn't reverse twice.
  insert into public.ledger_entries (
    venue_id, order_id, venue_night_id, party, profile_id, kind, amount, currency, refund_id
  )
  select e.venue_id, e.order_id, e.venue_night_id, e.party, e.profile_id, 'refund_reversal', -e.amount, e.currency, v_refund_id
  from public.ledger_entries e
  where e.order_id = p_order_id and e.kind = 'share'
  on conflict (order_id, party, kind) do nothing;

  return v_refund_id;
end;
$$;

-- Any rejection of a paid order is refunded. The reason comes from the caller
-- (set_config('app.refund_reason', ...)); staff rejections are the default.
create function public.refund_on_rejection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'rejected' and old.status <> 'rejected' and new.paid_at is not null then
    perform public.request_refund(
      new.id,
      coalesce(nullif(current_setting('app.refund_reason', true), ''), 'rejected_by_staff')
    );
  end if;
  return null;
end;
$$;

create trigger orders_refund_on_rejection
  after update of status on public.orders
  for each row execute function public.refund_on_rejection();

-- Late payment on an expired order: record it, then refund it (the customer
-- has most likely gone). Goes straight to rejected, so it never shows on the
-- club screen.
create or replace function public.record_paid_order(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_order_id uuid,
  p_checkout_id text,
  p_collection_id text,
  p_amount numeric,
  p_currency text
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_split public.venue_splits%rowtype;
  v_target public.venue_target_splits%rowtype;
  v_dj_set public.venue_sets%rowtype;
  v_mc_set public.venue_sets%rowtype;
  v_payment_id uuid;
  v_dj_profile uuid;
  v_mc_profile uuid;
  v_has_dj boolean;
  v_has_mc boolean;
  v_late boolean;
begin
  insert into public.webhook_events (provider, provider_event_id, type, payload)
  values (p_provider, p_event_id, p_event_type, p_payload)
  on conflict (provider, provider_event_id) do nothing;
  if not found then
    if exists (
      select 1 from public.webhook_events
      where provider = p_provider and provider_event_id = p_event_id and processed_at is not null
    ) then
      return 'duplicate_event';
    end if;
    update public.webhook_events set payload = p_payload, error = null
    where provider = p_provider and provider_event_id = p_event_id;
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  if v_order.status not in ('pending_payment', 'expired') then
    update public.webhook_events set processed_at = now()
    where provider = p_provider and provider_event_id = p_event_id;
    return 'already_processed';
  end if;

  if p_amount <> v_order.amount or p_currency <> v_order.currency then
    raise exception 'payment % % does not match order % (% %)',
      p_amount, p_currency, p_order_id, v_order.amount, v_order.currency
      using errcode = '22023';
  end if;

  v_late := v_order.status = 'expired';

  update public.payments
  set provider_collection_id = p_collection_id, status = 'succeeded', raw = p_payload, updated_at = now()
  where provider = p_provider and provider_checkout_id = p_checkout_id and order_id = p_order_id
  returning id into v_payment_id;

  if v_payment_id is null then
    insert into public.payments (
      venue_id, order_id, provider, provider_checkout_id, provider_collection_id,
      amount, currency, status, raw
    ) values (
      v_order.venue_id, v_order.id, p_provider, p_checkout_id, p_collection_id,
      p_amount, p_currency, 'succeeded', p_payload
    );
  end if;

  select * into v_dj_set from public.venue_sets
  where venue_id = v_order.venue_id and role = 'dj' and span @> now();
  select * into v_mc_set from public.venue_sets
  where venue_id = v_order.venue_id and role = 'mc' and span @> now();

  -- A late payment stays expired until its shares are written, then goes
  -- straight to rejected (below) so its refund reverses those shares.
  if not v_late then
    update public.orders
    set status = 'paid', paid_at = now(), dj_set_id = v_dj_set.id, mc_set_id = v_mc_set.id
    where id = p_order_id;
  end if;

  if v_order.type = 'spray' and v_order.target_profile_id is not null then
    select * into v_target from public.venue_target_splits where venue_id = v_order.venue_id;
    if not found then
      v_target := row(v_order.venue_id, 5000, 4000, 1000);
    end if;

    insert into public.ledger_entries (
      venue_id, order_id, venue_night_id, party, profile_id, kind, amount, currency
    )
    select
      v_order.venue_id, v_order.id, v_order.venue_night_id, s.party,
      case when s.party in ('dj', 'mc') then v_order.target_profile_id end,
      'share', s.amount, v_order.currency
    from public.compute_split(
      v_order.amount,
      v_target.club_bps,
      case when v_order.spray_target = 'dj' then v_target.target_bps else 0 end,
      case when v_order.spray_target = 'mc' then v_target.target_bps else 0 end,
      v_target.platform_bps,
      true,
      true
    ) as s
    where s.amount > 0;
  else
    select * into v_split from public.venue_splits
    where venue_id = v_order.venue_id and order_type = v_order.type;
    if not found then
      raise exception 'no split configured for venue % / %', v_order.venue_id, v_order.type
        using errcode = 'P0002';
    end if;

    if v_order.type = 'song_request' then
      v_has_dj := true;
      v_dj_profile := null;
    else
      v_has_dj := v_dj_set.id is not null;
      v_dj_profile := v_dj_set.profile_id;
    end if;
    if v_order.type = 'mc_shoutout' then
      v_has_mc := true;
      v_mc_profile := null;
    else
      v_has_mc := v_mc_set.id is not null;
      v_mc_profile := v_mc_set.profile_id;
    end if;

    insert into public.ledger_entries (
      venue_id, order_id, venue_night_id, party, profile_id, kind, amount, currency
    )
    select
      v_order.venue_id, v_order.id, v_order.venue_night_id, s.party,
      case s.party when 'dj' then v_dj_profile when 'mc' then v_mc_profile end,
      'share', s.amount, v_order.currency
    from public.compute_split(
      v_order.amount, v_split.club_bps, v_split.dj_bps, v_split.mc_bps, v_split.platform_bps,
      v_has_dj, v_has_mc
    ) as s
    where s.amount > 0;
  end if;

  if v_late then
    perform set_config('app.refund_reason', 'late_payment', true);
    update public.orders
    set status = 'rejected', paid_at = now(), dj_set_id = v_dj_set.id, mc_set_id = v_mc_set.id
    where id = p_order_id;
    perform set_config('app.refund_reason', '', true);
  end if;

  update public.webhook_events set processed_at = now(), error = null
  where provider = p_provider and provider_event_id = p_event_id;

  return case when v_late then 'recorded_late_refunding' else 'recorded' end;
end;
$$;

-- Scheduled jobs (pg_cron, every minute) ------------------------------------------

-- Song requests not played within the venue's timeout are refunded.
create function public.timeout_song_requests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('app.refund_reason', 'request_timeout', true);
  update public.orders o
  set status = 'rejected'
  from public.venues v
  where v.id = o.venue_id
    and o.type = 'song_request'
    and o.status in ('paid', 'approved')
    and o.paid_at + make_interval(mins => v.request_timeout_minutes) <= now();
  get diagnostics v_count = row_count;
  perform set_config('app.refund_reason', '', true);
  return v_count;
end;
$$;

-- Checkouts last 30 minutes; anything still unpaid well after that is expired.
-- (checkout.expired webhooks usually get there first.)
create function public.expire_stale_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.orders set status = 'expired'
  where status = 'pending_payment' and created_at <= now() - interval '45 minutes';
  get diagnostics v_count = row_count;
  update public.payments set status = 'failed', updated_at = now()
  where status = 'pending' and order_id in (
    select id from public.orders where status = 'expired'
  );
  return v_count;
end;
$$;

-- Refunds the worker should send now. Leases each row for 2 minutes
-- (skip locked), so overlapping runs don't double-send; the provider's
-- idempotency key covers anything that slips through.
-- p_order_id claims one order's refund straight away, ignoring the schedule
-- (admin "retry now", tests).
create function public.claim_due_refunds(p_limit integer default 20, p_order_id uuid default null)
returns table (
  id uuid,
  order_id uuid,
  amount text,
  currency text,
  reason text,
  idempotency_key text,
  provider text,
  charge_id text,
  attempts integer
)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select r.id from public.refunds r
    where r.status = 'pending'
      and (r.order_id = p_order_id or (p_order_id is null and r.next_attempt_at <= now()))
    order by r.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  leased as (
    update public.refunds r
    set next_attempt_at = now() + interval '2 minutes', attempts = r.attempts + 1, updated_at = now()
    from due where r.id = due.id
    returning r.*
  )
  select l.id, l.order_id, l.amount::text, l.currency, l.reason, l.idempotency_key, l.provider,
    (select p.provider_collection_id from public.payments p
     where p.order_id = l.order_id and p.status = 'succeeded'),
    l.attempts
  from leased l;
$$;

-- Provider outcome for a refund (webhook or worker). Final states are sticky.
create function public.record_refund_status(
  p_refund_id uuid,
  p_status public.refund_status,
  p_provider_refund_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
begin
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund % not found', p_refund_id using errcode = 'P0002';
  end if;
  if v_refund.status in ('succeeded', 'failed') then
    return;
  end if;

  update public.refunds
  set status = p_status,
      provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
      last_error = p_error,
      updated_at = now()
  where id = p_refund_id;

  if p_status = 'succeeded' then
    update public.orders set status = 'refunded' where id = v_refund.order_id and status <> 'refunded';
  end if;
end;
$$;

-- Calls the app's refund worker. Configured per environment through Vault
-- secrets `app_url` and `cron_secret` (scripts/configure-jobs.mjs locally);
-- does nothing until both exist.
create function public.kick_refund_worker()
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
  if not exists (select 1 from public.refunds where status = 'pending' and next_attempt_at <= now()) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/api/jobs/refunds',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

revoke execute on function public.request_refund(uuid, text) from public, anon, authenticated;
revoke execute on function public.timeout_song_requests() from public, anon, authenticated;
revoke execute on function public.expire_stale_orders() from public, anon, authenticated;
revoke execute on function public.claim_due_refunds(integer, uuid) from public, anon, authenticated;
revoke execute on function public.record_refund_status(uuid, public.refund_status, text, text) from public, anon, authenticated;
revoke execute on function public.kick_refund_worker() from public, anon, authenticated;
grant execute on function public.request_refund(uuid, text) to service_role;
grant execute on function public.claim_due_refunds(integer, uuid) to service_role;
grant execute on function public.record_refund_status(uuid, public.refund_status, text, text) to service_role;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.schedule('timeout-song-requests', '* * * * *', 'select public.timeout_song_requests()');
select cron.schedule('expire-stale-orders', '* * * * *', 'select public.expire_stale_orders()');
select cron.schedule('kick-refund-worker', '* * * * *', 'select public.kick_refund_worker()');

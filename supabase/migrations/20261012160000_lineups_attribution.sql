-- Lineups and attribution (CLAUDE.md "Lineups"):
--   * venue_sets replace the single DJ/MC per night; no overlapping sets of the
--     same role at a venue (exclusion constraint)
--   * DJ/MC shares go to the active set when the payment is confirmed, except:
--     song requests (DJ share) and MC shoutouts (MC share) are written
--     unassigned and assigned to whoever marks them played/read
--   * targeted sprays use a separate per-venue split (default 50/40/10)
--   * unassigned shares are never settled

create extension if not exists btree_gist with schema extensions;

-- Sets ----------------------------------------------------------------------

create table public.venue_sets (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  venue_night_id uuid not null,
  profile_id uuid not null references public.profiles (id),
  role public.staff_role not null check (role in ('dj', 'mc')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz, -- null: still on
  source text not null default 'lineup' check (source in ('lineup', 'clock_in')),
  confirmed_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  span tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  foreign key (venue_night_id, venue_id) references public.venue_nights (id, venue_id),
  check (ends_at is null or ends_at > starts_at),
  -- One DJ and one MC at a time. Back-to-back ([) ranges) is allowed.
  constraint venue_sets_no_overlap exclude using gist (venue_id with =, role with =, span with &&)
);

create index venue_sets_night_idx on public.venue_sets (venue_night_id);
create index venue_sets_profile_idx on public.venue_sets (profile_id);

-- The person on a set must be active staff of the venue in that role.
create function public.check_set_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.venue_staff s
    where s.venue_id = new.venue_id and s.profile_id = new.profile_id
      and s.role = new.role and s.status = 'active'
  ) then
    raise exception 'profile % is not an active % at venue %', new.profile_id, new.role, new.venue_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger venue_sets_check_staff
  before insert or update of profile_id, role, venue_id on public.venue_sets
  for each row execute function public.check_set_staff();

-- Carry existing nights' DJ/MC over as sets, then drop the old columns.
insert into public.venue_sets (venue_id, venue_night_id, profile_id, role, starts_at, ends_at, confirmed_by)
select n.venue_id, n.id, x.profile_id, x.role, coalesce(n.opened_at, n.created_at), n.closed_at, null
from public.venue_nights n
cross join lateral (
  values (n.dj_profile_id, 'dj'::public.staff_role), (n.mc_profile_id, 'mc'::public.staff_role)
) as x (profile_id, role)
where x.profile_id is not null;

drop trigger venue_nights_check_staff on public.venue_nights;
drop function public.check_night_staff();
alter table public.venue_nights drop column dj_profile_id, drop column mc_profile_id;

-- Targeted spray split ------------------------------------------------------

create table public.venue_target_splits (
  venue_id uuid primary key references public.venues (id),
  target_bps integer not null default 5000 check (target_bps >= 0),
  club_bps integer not null default 4000 check (club_bps >= 0),
  platform_bps integer not null default 1000 check (platform_bps >= 0),
  check (target_bps + club_bps + platform_bps = 10000)
);

insert into public.venue_target_splits (venue_id) select id from public.venues;

-- Orders: targets and the sets active at payment -----------------------------

-- Existing sprays named only a role (or a celebrant, now out of scope) and no
-- person, so they become untargeted.
update public.orders set spray_target = null where spray_target is not null;

alter table public.orders
  add column target_profile_id uuid references public.profiles (id),
  add column dj_set_id uuid references public.venue_sets (id),
  add column mc_set_id uuid references public.venue_sets (id),
  drop constraint orders_check,
  add constraint orders_spray_target_check
    check (spray_target is null or (type = 'spray' and spray_target in ('dj', 'mc'))),
  add constraint orders_target_profile_check
    check ((spray_target is null) = (target_profile_id is null));

-- A spray can only target an active DJ/MC of this venue, in that role.
create function public.check_order_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_profile_id is not null and not exists (
    select 1 from public.venue_staff s
    where s.venue_id = new.venue_id and s.profile_id = new.target_profile_id
      and s.role = new.spray_target::text::public.staff_role and s.status = 'active'
  ) then
    raise exception 'spray target % is not an active % at this venue', new.target_profile_id, new.spray_target
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger orders_check_target
  before insert or update of target_profile_id, spray_target on public.orders
  for each row execute function public.check_order_target();

-- Ledger: unassigned DJ/MC shares ---------------------------------------------

alter table public.ledger_entries
  drop constraint ledger_entries_check,
  -- club/platform never have a profile; a dj/mc share without one is unassigned.
  add constraint ledger_entries_profile_check check (party in ('dj', 'mc') or profile_id is null),
  add column assigned_at timestamptz,
  add column assigned_by uuid references public.profiles (id);

create index ledger_entries_unassigned_idx on public.ledger_entries (order_id)
  where profile_id is null and party in ('dj', 'mc');

-- Append-only, except the one allowed update: assigning an unassigned share.
create or replace function public.ledger_entries_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and old.kind = 'share' and old.party in ('dj', 'mc')
    and old.profile_id is null and new.profile_id is not null
    and old.assigned_at is null and new.assigned_at is not null
    and (new.id, new.venue_id, new.order_id, new.venue_night_id, new.party, new.kind,
         new.amount, new.currency, new.refund_id, new.created_at)
      is not distinct from
        (old.id, old.venue_id, old.order_id, old.venue_night_id, old.party, old.kind,
         old.amount, old.currency, old.refund_id, old.created_at)
  then
    return new;
  end if;
  raise exception 'ledger_entries is append-only' using errcode = '42501';
end;
$$;

-- Only a DJ marks a song played; only an MC marks an MC shoutout read.
create or replace function public.enforce_order_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') or new.status = old.status then
    return new;
  end if;

  if old.status::text || '>' || new.status::text not in (
    'paid>approved', 'paid>rejected', 'paid>fulfilled',
    'approved>fulfilled', 'approved>rejected'
  ) then
    raise exception 'order status change % -> % is not allowed', old.status, new.status
      using errcode = '42501';
  end if;

  if new.status = 'fulfilled' then
    if new.type = 'song_request' and not public.has_venue_role(new.venue_id, '{dj}') then
      raise exception 'only a DJ can mark a song request played' using errcode = '42501';
    end if;
    if new.type = 'mc_shoutout' and not public.has_venue_role(new.venue_id, '{mc}') then
      raise exception 'only an MC can mark an MC shoutout read' using errcode = '42501';
    end if;
  end if;

  new.decided_by := auth.uid();
  new.decided_at := now();
  return new;
end;
$$;

-- Fulfilment assigns the unassigned share to whoever fulfilled it. A
-- fulfilment by service_role (no user) leaves it unassigned for admin review.
create function public.assign_fulfilment_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_party public.ledger_party;
  v_assignee uuid := auth.uid();
begin
  if new.status <> 'fulfilled' or old.status = 'fulfilled' or v_assignee is null then
    return null;
  end if;
  v_party := case new.type when 'song_request' then 'dj' when 'mc_shoutout' then 'mc' end;
  if v_party is null then
    return null;
  end if;

  update public.ledger_entries
  set profile_id = v_assignee, assigned_at = now(), assigned_by = v_assignee
  where order_id = new.id and kind = 'share' and party = v_party and profile_id is null;
  return null;
end;
$$;

create trigger orders_assign_fulfilment_share
  after update of status on public.orders
  for each row execute function public.assign_fulfilment_share();

-- Payment recording with set attribution -------------------------------------

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

  -- Who is on now (at most one of each, guaranteed by venue_sets_no_overlap).
  select * into v_dj_set from public.venue_sets
  where venue_id = v_order.venue_id and role = 'dj' and span @> now();
  select * into v_mc_set from public.venue_sets
  where venue_id = v_order.venue_id and role = 'mc' and span @> now();

  update public.orders
  set status = 'paid', paid_at = now(), dj_set_id = v_dj_set.id, mc_set_id = v_mc_set.id
  where id = p_order_id;

  if v_order.type = 'spray' and v_order.target_profile_id is not null then
    -- Targeted spray: target / club / platform, regardless of who's on.
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

    -- Song requests / MC shoutouts: that share is earned by whoever plays/reads
    -- it, so it's written unassigned (and never falls back to the club).
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

  update public.webhook_events set processed_at = now(), error = null
  where provider = p_provider and provider_event_id = p_event_id;

  return 'recorded';
end;
$$;

-- Lineup actions ----------------------------------------------------------------

-- Put someone on as the DJ/MC now. If someone else is on in that role, their
-- set ends at the same instant (a clean handover, no gap or overlap).
-- Runs as the caller: RLS and column grants decide (managers only).
create function public.start_set(p_venue_id uuid, p_role public.staff_role, p_profile_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_night_id uuid;
  v_now timestamptz := now();
  v_set_id uuid;
begin
  select n.id into v_night_id from public.venue_nights n
  where n.venue_id = p_venue_id and n.opened_at is not null and n.closed_at is null;
  if v_night_id is null then
    raise exception 'no open night at this venue' using errcode = 'P0002';
  end if;

  update public.venue_sets set ends_at = v_now
  where venue_id = p_venue_id and role = p_role and span @> v_now;

  insert into public.venue_sets (venue_id, venue_night_id, profile_id, role, starts_at, source)
  values (p_venue_id, v_night_id, p_profile_id, p_role, v_now, 'lineup')
  returning id into v_set_id;
  return v_set_id;
end;
$$;

-- End a set now (e.g. the DJ steps off and nobody takes over).
create function public.end_set(p_set_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.venue_sets set ends_at = now()
  where id = p_set_id and (ends_at is null or ends_at > now()) and starts_at < now();
  if not found then
    raise exception 'set % is not running', p_set_id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.start_set(uuid, public.staff_role, uuid) from public, anon;
revoke execute on function public.end_set(uuid) from public, anon;
grant execute on function public.start_set(uuid, public.staff_role, uuid) to authenticated;
grant execute on function public.end_set(uuid) to authenticated;

-- Settlement input -------------------------------------------------------------

-- What a night owes each payee (shares minus refund reversals). Unassigned
-- DJ/MC shares are excluded: they're never paid out until assigned. The
-- platform keeps its share, so it's not a payee. Used by the settlement job.
create function public.night_settlement_amounts(p_venue_night_id uuid)
returns table (party public.ledger_party, profile_id uuid, amount numeric(14, 2), currency text)
language sql
stable
set search_path = ''
as $$
  select e.party, e.profile_id, sum(e.amount)::numeric(14, 2), e.currency
  from public.ledger_entries e
  where e.venue_night_id = p_venue_night_id
    and e.party <> 'platform'
    and not (e.party in ('dj', 'mc') and e.profile_id is null)
  group by e.party, e.profile_id, e.currency
  having sum(e.amount) > 0;
$$;

-- Total still waiting for a DJ/MC to play/read it (for dashboards and checks).
create function public.night_unassigned_total(p_venue_night_id uuid)
returns numeric(14, 2)
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(e.amount), 0)::numeric(14, 2)
  from public.ledger_entries e
  where e.venue_night_id = p_venue_night_id
    and e.party in ('dj', 'mc') and e.profile_id is null;
$$;

revoke execute on function public.night_settlement_amounts(uuid) from public, anon, authenticated;
revoke execute on function public.night_unassigned_total(uuid) from public, anon, authenticated;
grant execute on function public.night_settlement_amounts(uuid) to service_role;
grant execute on function public.night_unassigned_total(uuid) to service_role;

-- Who an attendee can spray: active DJs and MCs of an active venue, by
-- display name, flagged if they're on right now. No other profile data.
create function public.venue_spray_targets(p_venue_id uuid)
returns table (profile_id uuid, role public.staff_role, name text, on_now boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.profile_id, s.role, p.display_name,
    exists (
      select 1 from public.venue_sets vs
      where vs.venue_id = s.venue_id and vs.profile_id = s.profile_id
        and vs.role = s.role and vs.span @> now()
    )
  from public.venue_staff s
  join public.profiles p on p.id = s.profile_id
  join public.venues v on v.id = s.venue_id
  where s.venue_id = p_venue_id and s.status = 'active' and s.role in ('dj', 'mc')
    and v.status = 'active' and p.display_name <> ''
  order by 4 desc, s.role, p.display_name;
$$;

grant execute on function public.venue_spray_targets(uuid) to anon, authenticated;

-- Screen broadcast: show the target's name instead of a role or celebrant.
create or replace function public.broadcast_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.status <> 'pending_payment' then
      perform realtime.send(
        jsonb_build_object('id', new.id, 'type', new.type, 'status', new.status),
        'order_changed',
        'venue:' || new.venue_id,
        true
      );
    end if;

    if new.type = 'spray' and new.status = 'paid'
      and (tg_op = 'INSERT' or old.status in ('pending_payment', 'expired')) then
      perform realtime.send(
        jsonb_build_object(
          'id', new.id,
          'name', public.screen_display_name(new),
          'table', new.table_label,
          'amount', new.amount::text,
          'target', new.spray_target,
          'targetName', (select p.display_name from public.profiles p where p.id = new.target_profile_id)
        ),
        'spray',
        'screen:' || new.venue_id,
        false
      );
    end if;

    if new.type = 'screen_shoutout' and new.status = 'approved'
      and tg_op = 'UPDATE' and old.status = 'paid' then
      perform realtime.send(
        jsonb_build_object('id', new.id, 'name', new.nickname, 'message', new.message),
        'shoutout',
        'screen:' || new.venue_id,
        false
      );
    end if;
  exception when others then
    raise warning 'broadcast_order_change failed for order %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- RLS ---------------------------------------------------------------------------

-- Supabase grants anon/authenticated everything on new tables by default.
-- Start the new tables from nothing (as in the RLS migration), and stop the
-- default for tables created from here on.
revoke all on public.venue_sets, public.venue_target_splits from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

alter table public.venue_sets enable row level security;
grant select on public.venue_sets to authenticated;
grant insert (venue_id, venue_night_id, profile_id, role, starts_at, ends_at, source)
  on public.venue_sets to authenticated;
grant update (starts_at, ends_at) on public.venue_sets to authenticated;

create policy "Staff and admins can read their venue sets" on public.venue_sets
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

create policy "Managers can add sets" on public.venue_sets
  for insert to authenticated
  with check (public.has_venue_role(venue_id, '{club_manager}'));

create policy "Managers can change sets" on public.venue_sets
  for update to authenticated
  using (public.has_venue_role(venue_id, '{club_manager}'))
  with check (public.has_venue_role(venue_id, '{club_manager}'));

alter table public.venue_target_splits enable row level security;
grant select on public.venue_target_splits to authenticated;
create policy "Staff and admins can read their venue target split" on public.venue_target_splits
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

-- Column grants that referenced the dropped night columns.
grant insert (venue_id, night_date, opened_at) on public.venue_nights to authenticated;
grant update (opened_at, closed_at) on public.venue_nights to authenticated;

-- Attendees may name a spray target (validated by orders_check_target).
grant insert (target_profile_id) on public.orders to anon, authenticated;

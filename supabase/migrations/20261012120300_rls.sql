-- Row Level Security and grants.
--
-- Roles:
--   anon           attendees (guest checkout, never signed in)
--   authenticated  staff (club_manager / dj / mc via venue_staff) and admins
--   service_role   our server (webhooks, cron, admin actions); bypasses RLS
--
-- Start from nothing and grant back exactly what each role needs. Column-level
-- grants stop staff writing fields RLS can't protect (e.g. profiles.is_admin).
-- Admin writes go through service_role server actions; admins only get read here.

revoke all on all tables in schema public from anon, authenticated;

-- Helpers. security definer so policies can consult venue_staff without
-- recursing through its own RLS.

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create function public.has_venue_role(p_venue_id uuid, p_roles public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.venue_staff s
    where s.venue_id = p_venue_id
      and s.profile_id = auth.uid()
      and s.status = 'active'
      and s.role = any (p_roles)
  );
$$;

create function public.is_venue_staff(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_venue_role(p_venue_id, enum_range(null::public.staff_role));
$$;

-- True when the caller and p_profile_id are both active staff at some venue.
create function public.shares_venue_with(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.venue_staff mine
    join public.venue_staff theirs on theirs.venue_id = mine.venue_id
    where mine.profile_id = auth.uid() and mine.status = 'active'
      and theirs.profile_id = p_profile_id and theirs.status = 'active'
  );
$$;

-- An attendee order is acceptable if the venue is active, the night is open,
-- the order type is enabled and the amount meets the minimum.
create function public.can_place_order(
  p_venue_id uuid,
  p_night_id uuid,
  p_type public.order_type,
  p_amount numeric,
  p_currency text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.venues v
    join public.venue_nights n on n.venue_id = v.id
    join public.venue_pricing p on p.venue_id = v.id and p.order_type = p_type
    where v.id = p_venue_id
      and n.id = p_night_id
      and v.status = 'active'
      and v.currency = p_currency
      and n.opened_at is not null and n.closed_at is null
      and p.enabled
      and p_amount >= p.min_amount
  );
$$;

-- Who approves/rejects/fulfils what. DJ: song requests. MC: MC shoutouts.
-- Manager: everything that needs a decision. Sprays need no decision.
create function public.can_decide_order(p_venue_id uuid, p_type public.order_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_type
    when 'song_request' then public.has_venue_role(p_venue_id, '{dj,club_manager}')
    when 'mc_shoutout' then public.has_venue_role(p_venue_id, '{mc,club_manager}')
    when 'screen_shoutout' then public.has_venue_role(p_venue_id, '{club_manager}')
    else false
  end;
$$;

-- venues --------------------------------------------------------------------

alter table public.venues enable row level security;
grant select on public.venues to anon, authenticated;
grant update (name, address, request_timeout_minutes) on public.venues to authenticated;

create policy "Anyone can read active venues" on public.venues
  for select to anon, authenticated
  using (status = 'active');

create policy "Staff and admins can read their venues" on public.venues
  for select to authenticated
  using (public.is_venue_staff(id) or public.is_admin());

create policy "Managers can update their venue" on public.venues
  for update to authenticated
  using (public.has_venue_role(id, '{club_manager}'))
  with check (public.has_venue_role(id, '{club_manager}'));

-- profiles ------------------------------------------------------------------

alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "Read own profile, venue colleagues, or as admin" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_venue_with(id) or public.is_admin());

create policy "Update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- venue_staff ---------------------------------------------------------------
-- Rows are created by invite acceptance (server-side, step 7).

alter table public.venue_staff enable row level security;
grant select on public.venue_staff to authenticated;
grant update (status) on public.venue_staff to authenticated;

create policy "Staff can see their venue's team" on public.venue_staff
  for select to authenticated
  using (profile_id = auth.uid() or public.is_venue_staff(venue_id) or public.is_admin());

create policy "Managers can revoke DJs and MCs" on public.venue_staff
  for update to authenticated
  using (role in ('dj', 'mc') and public.has_venue_role(venue_id, '{club_manager}'))
  with check (role in ('dj', 'mc') and public.has_venue_role(venue_id, '{club_manager}'));

-- invites -------------------------------------------------------------------

alter table public.invites enable row level security;
grant select, delete on public.invites to authenticated;
grant insert (venue_id, role, token_hash, expires_at) on public.invites to authenticated;

create policy "Managers and admins can read invites" on public.invites
  for select to authenticated
  using (public.has_venue_role(venue_id, '{club_manager}') or public.is_admin());

create policy "Managers can invite DJs and MCs" on public.invites
  for insert to authenticated
  with check (
    role in ('dj', 'mc')
    and public.has_venue_role(venue_id, '{club_manager}')
    and expires_at > now()
  );

create policy "Managers can delete unaccepted invites" on public.invites
  for delete to authenticated
  using (accepted_at is null and public.has_venue_role(venue_id, '{club_manager}'));

-- venue_pricing (public) ----------------------------------------------------

alter table public.venue_pricing enable row level security;
grant select on public.venue_pricing to anon, authenticated;
grant update (enabled, min_amount) on public.venue_pricing to authenticated;

create policy "Anyone can read pricing for active venues" on public.venue_pricing
  for select to anon, authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id and v.status = 'active'));

create policy "Staff and admins can read their venue pricing" on public.venue_pricing
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

-- The DJ controls song request minimums and can pause requests.
create policy "Managers (and DJs for song requests) can update pricing" on public.venue_pricing
  for update to authenticated
  using (
    public.has_venue_role(venue_id, '{club_manager}')
    or (order_type = 'song_request' and public.has_venue_role(venue_id, '{dj}'))
  )
  with check (
    public.has_venue_role(venue_id, '{club_manager}')
    or (order_type = 'song_request' and public.has_venue_role(venue_id, '{dj}'))
  );

-- venue_splits (private; changed by admins via service_role) -----------------

alter table public.venue_splits enable row level security;
grant select on public.venue_splits to authenticated;

create policy "Staff and admins can read their venue splits" on public.venue_splits
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

-- venue_nights --------------------------------------------------------------

alter table public.venue_nights enable row level security;
grant select (id, venue_id, night_date, opened_at, closed_at) on public.venue_nights to anon;
grant select on public.venue_nights to authenticated;
grant insert (venue_id, night_date, dj_profile_id, mc_profile_id, opened_at)
  on public.venue_nights to authenticated;
grant update (dj_profile_id, mc_profile_id, opened_at, closed_at)
  on public.venue_nights to authenticated;

create policy "Anyone can read the open night of an active venue" on public.venue_nights
  for select to anon, authenticated
  using (
    opened_at is not null and closed_at is null
    and exists (select 1 from public.venues v where v.id = venue_id and v.status = 'active')
  );

create policy "Staff and admins can read their venue nights" on public.venue_nights
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

create policy "Managers can create nights" on public.venue_nights
  for insert to authenticated
  with check (public.has_venue_role(venue_id, '{club_manager}'));

-- Settled nights are frozen.
create policy "Managers can update unsettled nights" on public.venue_nights
  for update to authenticated
  using (settled_at is null and public.has_venue_role(venue_id, '{club_manager}'))
  with check (settled_at is null and public.has_venue_role(venue_id, '{club_manager}'));

-- orders --------------------------------------------------------------------
-- Attendees can only create pending orders; they can't read orders back (the
-- server reports status by order ID). Staff decide orders for their venue.

alter table public.orders enable row level security;
grant insert (
  id, venue_id, venue_night_id, type, nickname, table_label, message,
  song_title, song_artist, spray_target, show_on_leaderboard, amount, currency
) on public.orders to anon, authenticated;
grant select on public.orders to authenticated;
grant update (status) on public.orders to authenticated;

create policy "Attendees can create pending orders" on public.orders
  for insert to anon, authenticated
  with check (
    status = 'pending_payment'
    and public.can_place_order(venue_id, venue_night_id, type, amount, currency)
  );

create policy "Staff and admins can read their venue orders" on public.orders
  for select to authenticated
  using (public.is_venue_staff(venue_id) or public.is_admin());

create policy "Staff can decide orders for their role" on public.orders
  for update to authenticated
  using (public.can_decide_order(venue_id, type))
  with check (public.can_decide_order(venue_id, type));

-- money tables: read-only for staff, written by service_role only ------------

alter table public.payments enable row level security;
grant select on public.payments to authenticated;
create policy "Managers and admins can read payments" on public.payments
  for select to authenticated
  using (public.has_venue_role(venue_id, '{club_manager}') or public.is_admin());

alter table public.refunds enable row level security;
grant select on public.refunds to authenticated;
create policy "Managers and admins can read refunds" on public.refunds
  for select to authenticated
  using (public.has_venue_role(venue_id, '{club_manager}') or public.is_admin());

alter table public.ledger_entries enable row level security;
grant select on public.ledger_entries to authenticated;
create policy "Managers, the earning DJ/MC, and admins can read ledger entries" on public.ledger_entries
  for select to authenticated
  using (
    profile_id = auth.uid()
    or public.has_venue_role(venue_id, '{club_manager}')
    or public.is_admin()
  );

alter table public.payouts enable row level security;
grant select on public.payouts to authenticated;
create policy "Managers, the paid DJ/MC, and admins can read payouts" on public.payouts
  for select to authenticated
  using (
    profile_id = auth.uid()
    or public.has_venue_role(venue_id, '{club_manager}')
    or public.is_admin()
  );

alter table public.payout_accounts enable row level security;
grant select on public.payout_accounts to authenticated;
create policy "Owners and admins can read payout accounts" on public.payout_accounts
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (venue_id is not null and public.has_venue_role(venue_id, '{club_manager}'))
    or public.is_admin()
  );

alter table public.webhook_events enable row level security;
grant select on public.webhook_events to authenticated;
create policy "Admins can read webhook events" on public.webhook_events
  for select to authenticated
  using (public.is_admin());

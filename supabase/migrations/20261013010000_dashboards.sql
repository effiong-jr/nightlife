-- Club manager and DJ/MC dashboards. Each function checks the caller itself
-- (manager of the venue / the signed-in person), so they're security definer
-- but can't reveal anyone else's numbers. Money is summed in numeric and
-- returned as 2-decimal text.

-- One night, live: takings, refunds, the club's share, by type, top tables,
-- orders per hour (Lagos time). Tables only (nicknames stay off dashboards).
create function public.club_night_summary(p_night_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_venue_id uuid;
  v_result jsonb;
begin
  select venue_id into v_venue_id from public.venue_nights where id = p_night_id;
  if v_venue_id is null then
    raise exception 'night % not found', p_night_id using errcode = 'P0002';
  end if;
  if not (public.has_venue_role(v_venue_id, '{club_manager}') or public.is_admin()) then
    raise exception 'only managers of this venue' using errcode = '42501';
  end if;

  with paid as (
    select o.* from public.orders o where o.venue_night_id = p_night_id and o.paid_at is not null
  ),
  refunded as (
    select distinct on (r.order_id) r.order_id, r.amount
    from public.refunds r join paid p on p.id = r.order_id where r.status <> 'failed'
  ),
  shares as (
    select e.party, sum(e.amount) as amount
    from public.ledger_entries e where e.venue_night_id = p_night_id group by e.party
  )
  select jsonb_build_object(
    'gross', (select coalesce(sum(amount), 0) from paid)::numeric(14, 2)::text,
    'orders', (select count(*) from paid),
    'refunded', (select coalesce(sum(amount), 0) from refunded)::numeric(14, 2)::text,
    'refundCount', (select count(*) from refunded),
    'net', ((select coalesce(sum(amount), 0) from paid) - (select coalesce(sum(amount), 0) from refunded))::numeric(14, 2)::text,
    'avgOrder', (select coalesce(round(avg(amount), 2), 0) from paid)::numeric(14, 2)::text,
    'clubShare', coalesce((select amount from shares where party = 'club'), 0)::numeric(14, 2)::text,
    'staffShare', coalesce((select sum(amount) from shares where party in ('dj', 'mc')), 0)::numeric(14, 2)::text,
    'byType', coalesce((
      select jsonb_agg(jsonb_build_object('type', type, 'orders', n, 'gross', g::numeric(14, 2)::text) order by g desc)
      from (select type, count(*) as n, sum(amount) as g from paid group by type) t
    ), '[]'::jsonb),
    'topTables', coalesce((
      select jsonb_agg(jsonb_build_object('table', label, 'orders', n, 'gross', g::numeric(14, 2)::text) order by g desc)
      from (
        select table_label as label, count(*) as n, sum(amount) as g
        from paid where table_label is not null and status not in ('refunded', 'rejected')
        group by table_label order by sum(amount) desc limit 5
      ) t
    ), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'orders', n, 'gross', g::numeric(14, 2)::text) order by h)
      from (
        select date_trunc('hour', paid_at at time zone 'Africa/Lagos') as h, count(*) as n, sum(amount) as g
        from paid group by 1
      ) t
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- Past nights for a venue (newest first) and what each staff member earned.
create function public.club_history(p_venue_id uuid, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (public.has_venue_role(p_venue_id, '{club_manager}') or public.is_admin()) then
    raise exception 'only managers of this venue' using errcode = '42501';
  end if;

  with nights as (
    select * from public.venue_nights
    where venue_id = p_venue_id and opened_at is not null
    order by night_date desc limit p_limit
  ),
  per_night as (
    select
      n.id, n.night_date, n.closed_at, n.settled_at,
      (select count(*) from public.orders o where o.venue_night_id = n.id and o.paid_at is not null) as orders,
      (select coalesce(sum(o.amount), 0) from public.orders o where o.venue_night_id = n.id and o.paid_at is not null) as gross,
      (select coalesce(sum(r.amount), 0) from public.refunds r join public.orders o on o.id = r.order_id
        where o.venue_night_id = n.id and r.status <> 'failed') as refunded,
      (select coalesce(sum(e.amount), 0) from public.ledger_entries e where e.venue_night_id = n.id and e.party = 'club') as club_share,
      (select coalesce(sum(e.amount), 0) from public.ledger_entries e
        where e.venue_night_id = n.id and e.party in ('dj', 'mc') and e.profile_id is not null) as staff_share,
      (select jsonb_build_object('amount', p.amount::numeric(14, 2)::text, 'status', p.status, 'heldReason', p.held_reason, 'paidAt', p.paid_at)
        from public.payouts p where p.venue_night_id = n.id and p.party = 'club') as club_payout
    from nights n
  ),
  staff as (
    select e.profile_id, pr.display_name, array_agg(distinct e.party::text) as roles,
      count(distinct e.venue_night_id) as nights, sum(e.amount) as earned
    from public.ledger_entries e
    join nights n on n.id = e.venue_night_id
    join public.profiles pr on pr.id = e.profile_id
    where e.party in ('dj', 'mc') and e.profile_id is not null
    group by e.profile_id, pr.display_name
  )
  select jsonb_build_object(
    'nights', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'date', night_date, 'open', closed_at is null, 'settled', settled_at is not null,
        'orders', orders, 'gross', gross::numeric(14, 2)::text, 'refunded', refunded::numeric(14, 2)::text,
        'clubShare', club_share::numeric(14, 2)::text, 'staffShare', staff_share::numeric(14, 2)::text,
        'clubPayout', club_payout
      ) order by night_date desc)
      from per_night
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profileId', profile_id, 'name', display_name, 'roles', roles, 'nights', nights,
        'earned', earned::numeric(14, 2)::text
      ) order by earned desc)
      from staff where earned > 0
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- The signed-in DJ/MC's earnings per night (all venues) and payouts.
create function public.my_earnings(p_limit integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select e.venue_night_id, sum(e.amount) as earned
    from public.ledger_entries e
    where e.profile_id = auth.uid() and e.party in ('dj', 'mc')
    group by e.venue_night_id
  ),
  nights as (
    select n.id, n.night_date, n.closed_at, v.name as venue, m.earned,
      (select jsonb_build_object(
          'amount', p.amount::numeric(14, 2)::text,
          'fee', public.payout_fee(p.currency)::numeric(14, 2)::text,
          'net', (p.amount - public.payout_fee(p.currency))::numeric(14, 2)::text,
          'status', p.status, 'heldReason', p.held_reason, 'paidAt', p.paid_at)
        from public.payouts p
        where p.venue_night_id = n.id and p.profile_id = auth.uid()
        order by p.created_at limit 1) as payout
    from mine m
    join public.venue_nights n on n.id = m.venue_night_id
    join public.venues v on v.id = n.venue_id
    order by n.night_date desc, v.name
    limit p_limit
  ),
  payouts as (
    select
      coalesce(sum(amount - public.payout_fee(currency)) filter (where status = 'paid'), 0) as paid_out,
      coalesce(sum(amount) filter (where status in ('held', 'pending', 'transferred', 'processing')), 0) as pending
    from public.payouts where profile_id = auth.uid()
  )
  select jsonb_build_object(
    'tonight', coalesce((select sum(m.earned) from mine m join public.venue_nights n on n.id = m.venue_night_id
                         where n.closed_at is null), 0)::numeric(14, 2)::text,
    'allTime', coalesce((select sum(earned) from mine), 0)::numeric(14, 2)::text,
    'paidOut', (select paid_out from payouts)::numeric(14, 2)::text,
    'pending', (select pending from payouts)::numeric(14, 2)::text,
    'nights', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nightId', id, 'date', night_date, 'venue', venue, 'open', closed_at is null,
        'earned', earned::numeric(14, 2)::text, 'payout', payout
      ) order by night_date desc, venue)
      from nights
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

revoke execute on function public.club_night_summary(uuid) from public, anon;
revoke execute on function public.club_history(uuid, integer) from public, anon;
revoke execute on function public.my_earnings(integer) from public, anon;
grant execute on function public.club_night_summary(uuid) to authenticated;
grant execute on function public.club_history(uuid, integer) to authenticated;
grant execute on function public.my_earnings(integer) to authenticated;

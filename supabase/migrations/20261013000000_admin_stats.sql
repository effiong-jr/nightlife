-- Platform-wide stats for the admin dashboard, for orders paid in [p_from, p_to).
-- Money is summed in numeric and returned as text (never floats).
--   gross            money taken (all paid orders, before refunds)
--   refunded         live refunds of those orders (not failed attempts)
--   net              gross - refunded
--   platformRevenue  the platform's ledger share net of reversals
-- Daily series: the last p_days Lagos business days ending at p_to.
create function public.admin_stats(p_from timestamptz, p_to timestamptz, p_days integer default 14)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select o.id, o.venue_id, o.type, o.amount, o.paid_at
    from public.orders o
    where o.paid_at >= p_from and o.paid_at < p_to
  ),
  refunded as (
    select distinct on (r.order_id) r.order_id, r.amount
    from public.refunds r
    join paid p on p.id = r.order_id
    where r.status <> 'failed'
  ),
  platform as (
    select e.order_id, sum(e.amount) as amount
    from public.ledger_entries e
    join paid p on p.id = e.order_id
    where e.party = 'platform'
    group by e.order_id
  ),
  totals as (
    select
      (select coalesce(sum(amount), 0) from paid) as gross,
      (select count(*) from paid) as orders,
      (select coalesce(sum(amount), 0) from refunded) as refunded,
      (select count(*) from refunded) as refund_count,
      (select coalesce(sum(amount), 0) from platform) as platform_revenue,
      (select coalesce(round(avg(amount), 2), 0) from paid) as avg_order
  ),
  by_type as (
    select p.type, count(*) as orders, sum(p.amount) as gross
    from paid p group by p.type
  ),
  by_venue as (
    select
      v.id, v.name, v.slug, v.status,
      count(p.id) as orders,
      coalesce(sum(p.amount), 0) as gross,
      coalesce(sum(r.amount), 0) as refunded,
      coalesce(sum(pl.amount), 0) as platform_revenue,
      (select max(n.night_date) from public.venue_nights n where n.venue_id = v.id and n.opened_at is not null) as last_night
    from public.venues v
    left join paid p on p.venue_id = v.id
    left join refunded r on r.order_id = p.id
    left join platform pl on pl.order_id = p.id
    group by v.id
  ),
  days as (
    select d::date as day
    from generate_series(
      public.business_date(p_to - interval '1 microsecond') - (p_days - 1),
      public.business_date(p_to - interval '1 microsecond'),
      interval '1 day'
    ) as d
  ),
  daily as (
    select d.day, count(o.id) as orders, coalesce(sum(o.amount), 0) as gross
    from days d
    left join public.orders o on o.paid_at is not null and public.business_date(o.paid_at) = d.day
    group by d.day
  ),
  payouts as (
    select
      coalesce(sum(amount) filter (where status = 'paid' and paid_at >= p_from and paid_at < p_to), 0) as paid_out,
      coalesce(sum(amount) filter (where status in ('pending', 'transferred', 'processing')), 0) as in_flight,
      coalesce(sum(amount) filter (where status = 'held'), 0) as held,
      count(*) filter (where status = 'held') as held_count,
      count(*) filter (where status = 'failed') as failed_count
    from public.payouts
  )
  select jsonb_build_object(
    'gross', t.gross::numeric(14, 2)::text,
    'orders', t.orders,
    'refunded', t.refunded::numeric(14, 2)::text,
    'refundCount', t.refund_count,
    'net', (t.gross - t.refunded)::numeric(14, 2)::text,
    'platformRevenue', t.platform_revenue::numeric(14, 2)::text,
    'avgOrder', t.avg_order::numeric(14, 2)::text,
    'byType', coalesce((
      select jsonb_agg(jsonb_build_object('type', type, 'orders', orders, 'gross', gross::numeric(14, 2)::text) order by gross desc)
      from by_type
    ), '[]'::jsonb),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'slug', slug, 'status', status, 'orders', orders,
        'gross', gross::numeric(14, 2)::text, 'refunded', refunded::numeric(14, 2)::text,
        'net', (gross - refunded)::numeric(14, 2)::text, 'platformRevenue', platform_revenue::numeric(14, 2)::text, 'lastNight', last_night
      ) order by gross desc, name)
      from by_venue
    ), '[]'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', day, 'orders', orders, 'gross', gross::numeric(14, 2)::text) order by day)
      from daily
    ),
    'payouts', (
      select jsonb_build_object(
        'paidOut', paid_out::numeric(14, 2)::text, 'inFlight', in_flight::numeric(14, 2)::text,
        'held', held::numeric(14, 2)::text,
        'heldCount', held_count, 'failedCount', failed_count
      )
      from payouts
    ),
    'activeVenues', (select count(*) from public.venues where status = 'active'),
    'activeStaff', (
      select count(distinct profile_id) from public.venue_staff where status = 'active' and role in ('dj', 'mc')
    )
  )
  from totals t;
$$;

revoke execute on function public.admin_stats(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.admin_stats(timestamptz, timestamptz, integer) to service_role;

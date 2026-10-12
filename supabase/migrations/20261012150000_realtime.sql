-- Realtime: one private channel per venue for staff, one public channel per
-- venue for the club screen.
--
--   venue:<venue_id>   private. Every order change once payment has started
--                      (paid, approved, ...). Payload is just id/type/status:
--                      clients refetch through RLS, so missed events heal.
--   screen:<venue_id>  public. Only what's already shown on the big screen:
--                      paid sprays and approved screen shoutouts.

-- Only active staff of the venue may join its private channel.
create function public.can_join_venue_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_topic ~ '^venue:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_venue_staff(substring(p_topic from 7)::uuid);
$$;

create policy "Venue staff receive their venue's broadcasts" on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and public.can_join_venue_topic(realtime.topic()));

-- Display name on the screen. Opting out of the leaderboard also keeps the
-- nickname off the big screen next to an amount.
create function public.screen_display_name(p_order public.orders)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_order.show_on_leaderboard then p_order.nickname else 'A big spender' end;
$$;

create function public.broadcast_order_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Broadcasting must never break the transaction that changed the order
  -- (e.g. recording a payment), so failures only warn.
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
          'celebrant', case when new.spray_target = 'celebrant' then new.message end
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

create trigger orders_broadcast_change
  after insert or update of status on public.orders
  for each row execute function public.broadcast_order_change();

-- What the club screen shows when it (re)loads: tonight's top sprayers
-- (nicknames only, never amounts; opted-out orders excluded) and the latest
-- approved shoutouts. Public: it's exactly what's on the screen anyway.
create function public.screen_snapshot(p_venue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with night as (
    select n.id
    from public.venue_nights n
    join public.venues v on v.id = n.venue_id
    where n.venue_id = p_venue_id and v.status = 'active'
      and n.opened_at is not null and n.closed_at is null
  ),
  leaders as (
    select o.nickname
    from public.orders o
    where o.venue_night_id = (select id from night)
      and o.type = 'spray'
      and o.status in ('paid', 'approved', 'fulfilled')
      and o.show_on_leaderboard
    group by o.nickname
    order by sum(o.amount) desc, min(o.paid_at)
    limit 5
  ),
  shoutouts as (
    select o.id, o.nickname as name, o.message
    from public.orders o
    where o.venue_night_id = (select id from night)
      and o.type = 'screen_shoutout'
      and o.status in ('approved', 'fulfilled')
    order by o.decided_at desc
    limit 10
  )
  select jsonb_build_object(
    'open', exists (select 1 from night),
    'leaderboard', coalesce((select jsonb_agg(nickname) from leaders), '[]'::jsonb),
    'shoutouts', coalesce((select jsonb_agg(to_jsonb(s)) from shoutouts s), '[]'::jsonb)
  );
$$;

grant execute on function public.screen_snapshot(uuid) to anon, authenticated;

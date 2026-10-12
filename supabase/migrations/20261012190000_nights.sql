-- Opening and closing nights (CLAUDE.md "Lineups"; settlement runs on closed
-- nights).
--   * open_night: one open night per venue; the night's date is the Lagos
--     "business day", which runs until 06:00
--   * close_night: ends sets, refunds what can no longer happen (unplayed song
--     requests, unread MC shoutouts, unapproved screen shoutouts), marks shown
--     screen shoutouts done. Sprays are complete once paid.
--   * auto_close_nights: closes anything still open at 06:00 Lagos
--   * a payment arriving for a closed night is recorded, then refunded

alter table public.refunds drop constraint refunds_reason_check;
alter table public.refunds add constraint refunds_reason_check
  check (reason in ('rejected_by_staff', 'request_timeout', 'late_payment', 'night_closed', 'admin'));

-- Lagos business day: a night that starts at 22:00 and runs to 04:00 is one date.
create function public.business_date(p_at timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $$
  select ((p_at at time zone 'Africa/Lagos') - interval '6 hours')::date;
$$;

create function public.open_night(p_venue_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date := public.business_date();
  v_night public.venue_nights%rowtype;
begin
  if not public.has_venue_role(p_venue_id, '{club_manager}') then
    raise exception 'only a manager of this venue can open a night' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.venue_nights
    where venue_id = p_venue_id and opened_at is not null and closed_at is null
  ) then
    raise exception 'a night is already open' using errcode = '23505';
  end if;

  select * into v_night from public.venue_nights where venue_id = p_venue_id and night_date = v_date;
  if found then
    -- Closed by mistake earlier tonight: reopen it (unless already settled).
    if v_night.settled_at is not null then
      raise exception 'tonight has already been settled' using errcode = '22023';
    end if;
    update public.venue_nights set closed_at = null where id = v_night.id;
    return v_night.id;
  end if;

  insert into public.venue_nights (venue_id, night_date, opened_at)
  values (p_venue_id, v_date, now())
  returning id into v_night.id;
  return v_night.id;
end;
$$;

-- Managers close their own nights; the auto-close job runs as postgres.
create function public.close_night(p_night_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_night public.venue_nights%rowtype;
  v_refunded integer;
begin
  select * into v_night from public.venue_nights where id = p_night_id for update;
  if not found then
    raise exception 'night % not found', p_night_id using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not public.has_venue_role(v_night.venue_id, '{club_manager}') then
    raise exception 'only a manager of this venue can close a night' using errcode = '42501';
  end if;
  if v_night.closed_at is not null then
    return 0;
  end if;

  update public.venue_sets set ends_at = now()
  where venue_night_id = p_night_id and starts_at < now() and (ends_at is null or ends_at > now());

  -- Screen shoutouts already approved were shown: done.
  update public.orders set status = 'fulfilled'
  where venue_night_id = p_night_id and type = 'screen_shoutout' and status = 'approved';

  -- Anything still waiting can't happen now: refund it.
  perform set_config('app.refund_reason', 'night_closed', true);
  update public.orders set status = 'rejected'
  where venue_night_id = p_night_id
    and type in ('song_request', 'mc_shoutout', 'screen_shoutout')
    and status in ('paid', 'approved');
  get diagnostics v_refunded = row_count;
  perform set_config('app.refund_reason', '', true);

  update public.venue_nights set closed_at = now() where id = p_night_id;
  return v_refunded;
end;
$$;

-- 06:00 Lagos (05:00 UTC): close every night still open.
create function public.auto_close_nights()
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
    select id from public.venue_nights where opened_at is not null and closed_at is null
  loop
    perform public.close_night(v_night_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

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

  -- Late: the order expired, or its night has closed. Recorded, then refunded.
  v_late := v_order.status = 'expired'
    or exists (select 1 from public.venue_nights n where n.id = v_order.venue_night_id and n.closed_at is not null);

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

revoke execute on function public.open_night(uuid) from public, anon;
revoke execute on function public.close_night(uuid) from public, anon;
revoke execute on function public.auto_close_nights() from public, anon, authenticated;
grant execute on function public.open_night(uuid) to authenticated;
grant execute on function public.close_night(uuid) to authenticated, service_role;

select cron.schedule('auto-close-nights', '0 5 * * *', 'select public.auto_close_nights()');

-- Revenue split and paid-order recording. This is the only place the split rule
-- lives, so it always runs in the same transaction that writes the ledger.

-- Splits an amount by basis points, working in integer kobo (minor units) so
-- there is no rounding drift:
--   * each party gets floor(amount * bps / 10000)
--   * a DJ/MC share with nobody on duty goes to the club
--   * the leftover kobo (at most 2) goes to the platform
-- Always returns all four parties, possibly with 0.00.
create function public.compute_split(
  p_amount numeric,
  p_club_bps integer,
  p_dj_bps integer,
  p_mc_bps integer,
  p_platform_bps integer,
  p_has_dj boolean,
  p_has_mc boolean
)
returns table (party public.ledger_party, amount numeric(14, 2))
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kobo bigint;
  v_club_bps integer := p_club_bps;
  v_club bigint;
  v_dj bigint := 0;
  v_mc bigint := 0;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount, 2) then
    raise exception 'amount must be positive with at most 2 decimal places, got %', p_amount
      using errcode = '22023';
  end if;
  if least(p_club_bps, p_dj_bps, p_mc_bps, p_platform_bps) < 0
    or p_club_bps + p_dj_bps + p_mc_bps + p_platform_bps <> 10000 then
    raise exception 'split basis points must be non-negative and sum to 10000'
      using errcode = '22023';
  end if;

  v_kobo := (p_amount * 100)::bigint;

  if p_has_dj then
    v_dj := v_kobo * p_dj_bps / 10000;
  else
    v_club_bps := v_club_bps + p_dj_bps;
  end if;

  if p_has_mc then
    v_mc := v_kobo * p_mc_bps / 10000;
  else
    v_club_bps := v_club_bps + p_mc_bps;
  end if;

  v_club := v_kobo * v_club_bps / 10000;

  return query
    select s.party, (s.kobo::numeric / 100)::numeric(14, 2)
    from (values
      ('club'::public.ledger_party, v_club),
      ('dj'::public.ledger_party, v_dj),
      ('mc'::public.ledger_party, v_mc),
      ('platform'::public.ledger_party, v_kobo - v_club - v_dj - v_mc)
    ) as s (party, kobo);
end;
$$;

-- Called by the payment webhook handler (service_role) after the signature is
-- verified. In one transaction: records the event, marks the order paid and
-- writes one ledger share per party. Idempotent:
--   'recorded'          first time we see this payment
--   'duplicate_event'   this event ID was already recorded; nothing written
--   'already_processed' new event for an order that's already paid; event kept
-- Raises (and writes nothing, so the provider retries) on unknown order or
-- amount/currency mismatch.
-- An expired order can still be paid: the money arrived, so it's recorded.
create function public.record_paid_order(
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
  v_night public.venue_nights%rowtype;
  v_split public.venue_splits%rowtype;
  v_payment_id uuid;
begin
  insert into public.webhook_events (provider, provider_event_id, type, payload)
  values (p_provider, p_event_id, p_event_type, p_payload)
  on conflict (provider, provider_event_id) do nothing;
  if not found then
    return 'duplicate_event';
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

  update public.orders set status = 'paid', paid_at = now() where id = p_order_id;

  select * into v_night from public.venue_nights where id = v_order.venue_night_id;
  select * into v_split from public.venue_splits
  where venue_id = v_order.venue_id and order_type = v_order.type;
  if not found then
    raise exception 'no split configured for venue % / %', v_order.venue_id, v_order.type
      using errcode = 'P0002';
  end if;

  insert into public.ledger_entries (
    venue_id, order_id, venue_night_id, party, profile_id, kind, amount, currency
  )
  select
    v_order.venue_id, v_order.id, v_order.venue_night_id, s.party,
    case s.party when 'dj' then v_night.dj_profile_id when 'mc' then v_night.mc_profile_id end,
    'share', s.amount, v_order.currency
  from public.compute_split(
    v_order.amount, v_split.club_bps, v_split.dj_bps, v_split.mc_bps, v_split.platform_bps,
    v_night.dj_profile_id is not null, v_night.mc_profile_id is not null
  ) as s
  where s.amount > 0;

  update public.webhook_events set processed_at = now()
  where provider = p_provider and provider_event_id = p_event_id;

  return 'recorded';
end;
$$;

revoke execute on function public.compute_split(numeric, integer, integer, integer, integer, boolean, boolean)
  from public, anon, authenticated;
revoke execute on function public.record_paid_order(text, text, text, jsonb, uuid, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.compute_split(numeric, integer, integer, integer, integer, boolean, boolean)
  to service_role;
grant execute on function public.record_paid_order(text, text, text, jsonb, uuid, text, text, numeric, text)
  to service_role;

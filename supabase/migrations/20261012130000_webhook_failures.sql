-- Webhooks we can't act on (unknown order, amount mismatch, underpayment) are
-- kept with an error for admin review instead of being retried forever.
-- A replay of such an event (`bachs events replay`) is processed again; only
-- events that were successfully processed count as duplicates.

alter table public.webhook_events add column error text;

create function public.record_webhook_failure(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_error text
)
returns void
language sql
set search_path = ''
as $$
  insert into public.webhook_events (provider, provider_event_id, type, payload, error)
  values (p_provider, p_event_id, p_event_type, p_payload, p_error)
  on conflict (provider, provider_event_id) do update
    set error = excluded.error, payload = excluded.payload
    where public.webhook_events.processed_at is null;
$$;

revoke execute on function public.record_webhook_failure(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.record_webhook_failure(text, text, text, jsonb, text)
  to service_role;

-- Same as before, except an event that was stored but never processed (a failure)
-- is processed again rather than treated as a duplicate.
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
  v_night public.venue_nights%rowtype;
  v_split public.venue_splits%rowtype;
  v_payment_id uuid;
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

  update public.webhook_events set processed_at = now(), error = null
  where provider = p_provider and provider_event_id = p_event_id;

  return 'recorded';
end;
$$;

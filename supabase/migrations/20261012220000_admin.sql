-- Admin basics (CLAUDE.md build step 9): creating venues with sensible
-- defaults, adding managers, and the review queue (failed refunds, flagged
-- payments, failed/held payouts). Admin actions run server-side as
-- service_role after the app checks profiles.is_admin.

-- Flagged webhook events (over/underpayments, unknown orders, mismatches) can
-- be marked resolved once handled by hand.
alter table public.webhook_events
  add column resolved_at timestamptz,
  add column resolved_by uuid references public.profiles (id),
  add column resolution_note text check (length(resolution_note) <= 500);

-- A new venue starts pending with default prices and splits (placeholders until
-- the commercial terms are agreed; see CLAUDE.md).
create function public.create_venue(p_name text, p_slug text, p_address text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.venues (name, slug, address, status)
  values (p_name, p_slug, nullif(p_address, ''), 'pending')
  returning id into v_id;

  insert into public.venue_pricing (venue_id, order_type, min_amount) values
    (v_id, 'spray', 1000.00),
    (v_id, 'screen_shoutout', 2000.00),
    (v_id, 'mc_shoutout', 2000.00),
    (v_id, 'song_request', 5000.00);

  insert into public.venue_splits (venue_id, order_type, club_bps, dj_bps, mc_bps, platform_bps) values
    (v_id, 'spray', 4000, 2500, 2500, 1000),
    (v_id, 'screen_shoutout', 6500, 1000, 1500, 1000),
    (v_id, 'mc_shoutout', 4000, 0, 5000, 1000),
    (v_id, 'song_request', 3000, 6000, 0, 1000);

  insert into public.venue_target_splits (venue_id) values (v_id);
  return v_id;
end;
$$;

-- Staff sign in with their phone; Supabase stores it without the "+".
create function public.find_user_by_phone(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where phone = ltrim(p_phone, '+') limit 1;
$$;

-- Retry a refund that failed (e.g. after fixing it with Bachs): a new attempt.
create function public.retry_refund(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.refunds where order_id = p_order_id and status = 'failed') then
    raise exception 'no failed refund for order %', p_order_id using errcode = '22023';
  end if;
  return public.request_refund(p_order_id, 'admin');
end;
$$;

-- Retry a failed payout: back to the hop it failed at, sent straight away.
create function public.retry_payout(p_payout_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payouts
  set status = case when provider_transfer_id is not null then 'transferred' else 'pending' end::public.payout_status,
      attempts = 0, next_attempt_at = now(), last_error = null, provider_payout_id = null, updated_at = now()
  where id = p_payout_id and status = 'failed';
  if not found then
    raise exception 'payout % is not failed', p_payout_id using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.create_venue(text, text, text) from public, anon, authenticated;
revoke execute on function public.find_user_by_phone(text) from public, anon, authenticated;
revoke execute on function public.retry_refund(uuid) from public, anon, authenticated;
revoke execute on function public.retry_payout(uuid) from public, anon, authenticated;
grant execute on function public.create_venue(text, text, text) to service_role;
grant execute on function public.find_user_by_phone(text) to service_role;
grant execute on function public.retry_refund(uuid) to service_role;
grant execute on function public.retry_payout(uuid) to service_role;

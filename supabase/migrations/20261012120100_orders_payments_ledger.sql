-- Orders and money tables. Amounts are numeric(14,2) + ISO currency, never floats.

create type public.order_status as enum (
  'pending_payment', 'paid', 'approved', 'rejected', 'fulfilled', 'refunded', 'expired'
);
create type public.spray_target as enum ('dj', 'mc', 'celebrant');
create type public.ledger_party as enum ('club', 'dj', 'mc', 'platform');
create type public.ledger_kind as enum ('share', 'refund_reversal');
create type public.payment_status as enum ('pending', 'succeeded', 'failed');
create type public.refund_status as enum ('pending', 'succeeded', 'failed');
create type public.payout_status as enum ('pending', 'processing', 'paid', 'failed');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  venue_night_id uuid not null,
  type public.order_type not null,
  status public.order_status not null default 'pending_payment',
  nickname text not null check (length(btrim(nickname)) between 1 and 30),
  table_label text check (length(table_label) <= 20),
  message text check (length(message) <= 140),
  song_title text check (length(song_title) <= 120),
  song_artist text check (length(song_artist) <= 120),
  spray_target public.spray_target,
  show_on_leaderboard boolean not null default true,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  foreign key (venue_night_id, venue_id) references public.venue_nights (id, venue_id),
  unique (id, venue_id),
  check ((type = 'spray') = (spray_target is not null)),
  check (type <> 'song_request' or song_title is not null),
  check (type not in ('screen_shoutout', 'mc_shoutout') or message is not null),
  -- Money was received exactly when the order left pending_payment/expired.
  check ((status in ('pending_payment', 'expired')) = (paid_at is null))
);

create index orders_venue_night_status_idx on public.orders (venue_night_id, status);
create index orders_venue_created_idx on public.orders (venue_id, created_at desc);

-- Staff (anon/authenticated) may only move orders along these edges. Payment,
-- expiry and refund transitions happen server-side as service_role.
-- decided_by/decided_at are always stamped here, never trusted from the client.
create function public.enforce_order_transition()
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

  new.decided_by := auth.uid();
  new.decided_at := now();
  return new;
end;
$$;

create trigger orders_enforce_transition
  before update of status on public.orders
  for each row execute function public.enforce_order_transition();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  order_id uuid not null,
  provider text not null,
  provider_checkout_id text,
  provider_collection_id text,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status public.payment_status not null default 'pending',
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (order_id, venue_id) references public.orders (id, venue_id),
  unique (provider, provider_checkout_id),
  unique (provider, provider_collection_id),
  check (status <> 'succeeded' or provider_collection_id is not null)
);

create index payments_order_id_idx on public.payments (order_id);
create unique index payments_one_succeeded_per_order
  on public.payments (order_id) where status = 'succeeded';

-- Every provider webhook we accept. The unique key makes processing idempotent.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

-- MVP: full refunds only, so at most one refund per order.
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  order_id uuid not null unique,
  provider text not null,
  provider_refund_id text,
  idempotency_key text not null unique,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status public.refund_status not null default 'pending',
  reason text not null check (length(reason) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (order_id, venue_id) references public.orders (id, venue_id),
  unique (provider, provider_refund_id)
);

-- Source of truth for who is owed what. Append-only.
-- club/platform entries have no profile (club settles to the venue's payout account).
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  order_id uuid not null,
  venue_night_id uuid not null,
  party public.ledger_party not null,
  profile_id uuid references public.profiles (id),
  kind public.ledger_kind not null,
  amount numeric(14, 2) not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  refund_id uuid references public.refunds (id),
  created_at timestamptz not null default now(),
  foreign key (order_id, venue_id) references public.orders (id, venue_id),
  foreign key (venue_night_id, venue_id) references public.venue_nights (id, venue_id),
  check ((party in ('dj', 'mc')) = (profile_id is not null)),
  check (
    (kind = 'share' and amount > 0 and refund_id is null)
    or (kind = 'refund_reversal' and amount < 0 and refund_id is not null)
  ),
  -- One share (and at most one reversal) per party per order.
  unique (order_id, party, kind)
);

create index ledger_entries_night_idx on public.ledger_entries (venue_night_id, party);
create index ledger_entries_profile_idx on public.ledger_entries (profile_id) where profile_id is not null;

create function public.ledger_entries_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger_entries is append-only' using errcode = '42501';
end;
$$;

create trigger ledger_entries_no_update_or_delete
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_entries_append_only();

-- At commit, an order's share entries must sum exactly to the order amount.
create function public.check_order_shares_balance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_expected numeric(14, 2);
  v_sum numeric(14, 2);
begin
  if new.kind <> 'share' then
    return null;
  end if;

  select o.amount into v_expected from public.orders o where o.id = new.order_id;
  select coalesce(sum(e.amount), 0) into v_sum
  from public.ledger_entries e
  where e.order_id = new.order_id and e.kind = 'share';

  if v_sum <> v_expected then
    raise exception 'ledger shares for order % sum to %, expected %', new.order_id, v_sum, v_expected
      using errcode = '23514';
  end if;

  return null;
end;
$$;

create constraint trigger ledger_entries_shares_balance
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.check_order_shares_balance();

-- One settlement transfer per party per night.
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  venue_night_id uuid not null,
  party public.ledger_party not null check (party <> 'platform'),
  profile_id uuid references public.profiles (id),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null,
  provider_payout_id text,
  idempotency_key text not null unique,
  status public.payout_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (venue_night_id, venue_id) references public.venue_nights (id, venue_id),
  check ((party in ('dj', 'mc')) = (profile_id is not null)),
  unique (venue_night_id, party),
  unique (provider, provider_payout_id)
);

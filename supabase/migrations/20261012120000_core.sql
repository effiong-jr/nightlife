-- Core tables: venues, staff, invites, pricing/splits, nights, payout accounts.
-- Venues are never hard-deleted (suspend instead), so venue FKs don't cascade:
-- money records must outlive everything they point at.

create type public.venue_status as enum ('pending', 'active', 'suspended');
create type public.staff_role as enum ('club_manager', 'dj', 'mc');
create type public.staff_status as enum ('active', 'revoked');
create type public.order_type as enum ('spray', 'screen_shoutout', 'mc_shoutout', 'song_request');
create type public.payout_account_status as enum ('pending', 'active', 'restricted');

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  name text not null check (length(name) between 1 and 100),
  address text check (length(address) <= 300),
  status public.venue_status not null default 'pending',
  currency text not null default 'NGN' check (currency ~ '^[A-Z]{3}$'),
  -- Song requests not accepted/played within this window are refunded.
  request_timeout_minutes integer not null default 30
    check (request_timeout_minutes between 5 and 240),
  created_at timestamptz not null default now()
);

-- One row per auth user (staff and admins only; attendees never sign in).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 60),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 60));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.venue_staff (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role public.staff_role not null,
  status public.staff_status not null default 'active',
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (venue_id, profile_id, role)
);

create index venue_staff_profile_id_idx on public.venue_staff (profile_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  role public.staff_role not null,
  -- sha256 (hex) of the invite token. The raw token only ever lives in the link.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  accepted_by uuid references public.profiles (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  check ((accepted_by is null) = (accepted_at is null))
);

create index invites_venue_id_idx on public.invites (venue_id);

-- Public per-type settings: shown on the attendee page.
create table public.venue_pricing (
  venue_id uuid not null references public.venues (id),
  order_type public.order_type not null,
  enabled boolean not null default true,
  min_amount numeric(14, 2) not null check (min_amount > 0),
  primary key (venue_id, order_type)
);

-- Private per-type revenue split, in basis points (10000 = 100%).
-- Kept apart from venue_pricing so attendees and other venues can't read it.
create table public.venue_splits (
  venue_id uuid not null references public.venues (id),
  order_type public.order_type not null,
  club_bps integer not null check (club_bps >= 0),
  dj_bps integer not null check (dj_bps >= 0),
  mc_bps integer not null check (mc_bps >= 0),
  platform_bps integer not null check (platform_bps >= 0),
  primary key (venue_id, order_type),
  check (club_bps + dj_bps + mc_bps + platform_bps = 10000)
);

create table public.venue_nights (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues (id),
  night_date date not null,
  dj_profile_id uuid references public.profiles (id),
  mc_profile_id uuid references public.profiles (id),
  opened_at timestamptz,
  closed_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (venue_id, night_date),
  -- Target for composite FKs, so child rows can't point at another venue's night.
  unique (id, venue_id),
  check (closed_at is null or opened_at is not null),
  check (settled_at is null or closed_at is not null)
);

create unique index venue_nights_one_open_per_venue
  on public.venue_nights (venue_id)
  where opened_at is not null and closed_at is null;

-- The DJ/MC on duty must be active staff of that venue in that role.
create function public.check_night_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.dj_profile_id is not null and not exists (
    select 1 from public.venue_staff s
    where s.venue_id = new.venue_id and s.profile_id = new.dj_profile_id
      and s.role = 'dj' and s.status = 'active'
  ) then
    raise exception 'profile % is not an active DJ at venue %', new.dj_profile_id, new.venue_id
      using errcode = '23514';
  end if;

  if new.mc_profile_id is not null and not exists (
    select 1 from public.venue_staff s
    where s.venue_id = new.venue_id and s.profile_id = new.mc_profile_id
      and s.role = 'mc' and s.status = 'active'
  ) then
    raise exception 'profile % is not an active MC at venue %', new.mc_profile_id, new.venue_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger venue_nights_check_staff
  before insert or update of dj_profile_id, mc_profile_id on public.venue_nights
  for each row execute function public.check_night_staff();

-- Where a party's settlement goes. Exactly one owner: a venue (club share) or a
-- profile (DJ/MC share). Provider-neutral so we can add Paystack/Flutterwave.
create table public.payout_accounts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues (id),
  profile_id uuid references public.profiles (id),
  provider text not null,
  recipient_id text not null,
  status public.payout_account_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(venue_id, profile_id) = 1),
  unique (provider, venue_id),
  unique (provider, profile_id),
  unique (provider, recipient_id)
);

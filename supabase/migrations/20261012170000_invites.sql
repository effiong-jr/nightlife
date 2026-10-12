-- Staff onboarding, part 1: club invites (CLAUDE.md "Staff onboarding").
--   * venue_staff gets a lifecycle: source, joined_at, ended_at, and
--     active / removed / left
--   * invites: optional invitee name, cancellation, 7-day expiry by default
--   * invite_preview (public, by token) and accept_invite (signed-in user)
--   * profiles get a real name (display_name is the stage name)

create extension if not exists pgcrypto with schema extensions;

-- venue_staff lifecycle --------------------------------------------------------

-- 'revoked' becomes 'removed' (by the club); 'left' is the DJ/MC leaving.
alter type public.staff_status rename value 'revoked' to 'removed';
alter type public.staff_status add value 'left';

create type public.staff_source as enum ('invite', 'request', 'admin');

alter table public.venue_staff
  add column source public.staff_source not null default 'admin',
  add column joined_at timestamptz not null default now(),
  add column ended_at timestamptz;

update public.venue_staff set joined_at = created_at;

-- Leaving or being removed: stamp ended_at and end any set they're on now.
-- Coming back (re-invited): clear ended_at and restart joined_at.
-- Earnings already in the ledger are unaffected.
create function public.venue_staff_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'active' then
    new.ended_at := now();
    if new.role in ('dj', 'mc') then
      update public.venue_sets set ends_at = now()
      where venue_id = new.venue_id and profile_id = new.profile_id and role = new.role
        and starts_at < now() and (ends_at is null or ends_at > now());
    end if;
  elsif new.status = 'active' then
    new.ended_at := null;
    new.joined_at := now();
  end if;
  return new;
end;
$$;

create trigger venue_staff_lifecycle
  before update of status on public.venue_staff
  for each row execute function public.venue_staff_lifecycle();

-- A DJ/MC can leave a venue themselves (but never re-activate).
create policy "Staff can leave a venue" on public.venue_staff
  for update to authenticated
  using (profile_id = auth.uid() and status = 'active' and role in ('dj', 'mc'))
  with check (profile_id = auth.uid() and status::text = 'left');

-- Profiles: real name (private to the person, their venues' staff and admins;
-- never shown to attendees or next to amounts). display_name is the stage name.

alter table public.profiles
  add column real_name text not null default '' check (length(real_name) <= 100);

grant update (real_name) on public.profiles to authenticated;

-- Invites ------------------------------------------------------------------------

alter table public.invites
  add column invitee_name text check (length(invitee_name) <= 60),
  add column cancelled_at timestamptz,
  alter column expires_at set default now() + interval '7 days',
  add constraint invites_single_outcome check (accepted_at is null or cancelled_at is null);

-- Managers create invites without choosing the expiry (always 7 days) and can
-- cancel unused ones. They never see the raw token after creation: only its hash
-- is stored.
revoke insert, delete on public.invites from authenticated;
grant insert (venue_id, role, token_hash, invitee_name) on public.invites to authenticated;
grant update (cancelled_at) on public.invites to authenticated;
drop policy "Managers can delete unaccepted invites" on public.invites;

create policy "Managers can cancel unused invites" on public.invites
  for update to authenticated
  using (accepted_at is null and cancelled_at is null and public.has_venue_role(venue_id, '{club_manager}'))
  with check (accepted_at is null and public.has_venue_role(venue_id, '{club_manager}'));

create function public.invite_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- What the /join/<token> page shows. Knowing the token is the permission.
create function public.invite_preview(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'venueName', v.name,
    'venueSlug', v.slug,
    'role', i.role,
    'inviteeName', i.invitee_name,
    'expiresAt', i.expires_at,
    'state', case
      when i.cancelled_at is not null then 'cancelled'
      when i.accepted_at is not null then 'accepted'
      when i.expires_at <= now() then 'expired'
      when v.status <> 'active' then 'venue_unavailable'
      else 'valid'
    end
  )
  from public.invites i
  join public.venues v on v.id = i.venue_id
  where i.token_hash = public.invite_token_hash(p_token);
$$;

-- Accept an invite as the signed-in user: they become active staff in the
-- invited role. Single-use; re-accepting your own invite is a no-op.
create function public.accept_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.invites%rowtype;
  v_venue public.venues%rowtype;
begin
  if v_uid is null then
    raise exception 'sign in to accept this invite' using errcode = '42501';
  end if;

  select * into v_invite from public.invites
  where token_hash = public.invite_token_hash(p_token)
  for update;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
  select * into v_venue from public.venues where id = v_invite.venue_id;

  if v_invite.accepted_at is not null then
    if v_invite.accepted_by = v_uid then
      return jsonb_build_object('venueSlug', v_venue.slug, 'role', v_invite.role);
    end if;
    raise exception 'invite already used' using errcode = '22023';
  end if;
  if v_invite.cancelled_at is not null then
    raise exception 'invite cancelled' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = '22023';
  end if;
  if v_venue.status <> 'active' then
    raise exception 'venue not active' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid and display_name <> '' and real_name <> '') then
    raise exception 'add your real name and stage name first' using errcode = '22023';
  end if;

  insert into public.venue_staff (venue_id, profile_id, role, status, source, invited_by, joined_at)
  values (v_invite.venue_id, v_uid, v_invite.role, 'active', 'invite', v_invite.created_by, now())
  on conflict (venue_id, profile_id, role) do update
    set status = 'active', source = 'invite', invited_by = excluded.invited_by
    where public.venue_staff.status <> 'active';

  update public.invites set accepted_by = v_uid, accepted_at = now() where id = v_invite.id;

  return jsonb_build_object('venueSlug', v_venue.slug, 'role', v_invite.role);
end;
$$;

revoke execute on function public.invite_preview(text) from public;
revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.invite_preview(text) to anon, authenticated;
grant execute on function public.accept_invite(text) to authenticated;

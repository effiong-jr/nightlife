-- Local dev seed data. Runs after migrations on `npm run db:reset`.
-- Every login below uses the password: password123
--
--   admin@test.local     platform admin
--   manager@test.local   club manager, Test Lounge
--   dj@test.local        DJ, Test Lounge (on the decks now)
--   mc@test.local        MC, Test Lounge (on the mic now)
--   dj2@test.local       second DJ, Test Lounge (staff, not on a set: use for changeovers)
--
-- Attendee page: http://localhost:3000/v/test-lounge
-- Split percentages are placeholders until the commercial terms are agreed.

do $$
declare
  v_users constant jsonb := '[
    {"id": "00000000-0000-4000-8000-000000000001", "email": "admin@test.local",   "name": "Test Admin"},
    {"id": "00000000-0000-4000-8000-000000000002", "email": "manager@test.local", "name": "Test Manager"},
    {"id": "00000000-0000-4000-8000-000000000003", "email": "dj@test.local",      "name": "DJ Test"},
    {"id": "00000000-0000-4000-8000-000000000004", "email": "mc@test.local",      "name": "MC Test"},
    {"id": "00000000-0000-4000-8000-000000000005", "email": "dj2@test.local",     "name": "DJ Second"}
  ]';
  v_user jsonb;
begin
  for v_user in select * from jsonb_array_elements(v_users) loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', (v_user ->> 'id')::uuid, 'authenticated', 'authenticated',
      v_user ->> 'email', extensions.crypt('password123', extensions.gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}', jsonb_build_object('display_name', v_user ->> 'name'),
      now(), now(), '', '', '', ''
    );

    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), (v_user ->> 'id')::uuid, v_user ->> 'id', 'email',
      jsonb_build_object('sub', v_user ->> 'id', 'email', v_user ->> 'email', 'email_verified', true),
      now(), now(), now()
    );
  end loop;
end;
$$;

update public.profiles set is_admin = true where id = '00000000-0000-4000-8000-000000000001';

insert into public.venues (id, slug, name, address, status)
values ('10000000-0000-4000-8000-000000000001', 'test-lounge', 'Test Lounge', 'Victoria Island, Lagos', 'active');

insert into public.venue_staff (venue_id, profile_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'club_manager'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'dj'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'mc'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'dj');

insert into public.venue_pricing (venue_id, order_type, min_amount) values
  ('10000000-0000-4000-8000-000000000001', 'spray', 1000.00),
  ('10000000-0000-4000-8000-000000000001', 'screen_shoutout', 2000.00),
  ('10000000-0000-4000-8000-000000000001', 'mc_shoutout', 2000.00),
  ('10000000-0000-4000-8000-000000000001', 'song_request', 5000.00);

insert into public.venue_splits (venue_id, order_type, club_bps, dj_bps, mc_bps, platform_bps) values
  ('10000000-0000-4000-8000-000000000001', 'spray',           4000, 2500, 2500, 1000),
  ('10000000-0000-4000-8000-000000000001', 'screen_shoutout', 6500, 1000, 1500, 1000),
  ('10000000-0000-4000-8000-000000000001', 'mc_shoutout',     4000,    0, 5000, 1000),
  ('10000000-0000-4000-8000-000000000001', 'song_request',    3000, 6000,    0, 1000);

-- Targeted sprays: target 50 / club 40 / platform 10 (the defaults).
insert into public.venue_target_splits (venue_id)
values ('10000000-0000-4000-8000-000000000001');

-- Tonight is open, with DJ Test and MC Test on open-ended sets.
insert into public.venue_nights (id, venue_id, night_date, opened_at)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date, now());

insert into public.venue_sets (venue_id, venue_night_id, profile_id, role, starts_at, confirmed_by) values
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000003', 'dj', now(), '00000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000004', 'mc', now(), '00000000-0000-4000-8000-000000000002');

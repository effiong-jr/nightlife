# CLAUDE.md

Project guide for Claude Code. Read this before every task.

## What we're building

A web app for Nigerian nightclubs. Club-goers scan a QR code at their table and pay to:

- **Spray** money digitally on the DJ, hype man or a celebrant (animation on the club screen)
- **Shoutout** on the club screen (approved by staff first)
- **MC shoutout** read out by the hype man on the mic
- **Request a song** from the DJ (DJ accepts or rejects; unplayed requests are refunded automatically)

Money is split between the club, the DJ on duty, the hype man (MC) on duty, and the platform.

Web app only (no native app, no Bluetooth/offline mode). Multi-club from day one, piloting in one Lagos club in December 2026.

## Roles and surfaces

| Role | Surface | Route group |
| --- | --- | --- |
| Attendee | Venue page from table QR, guest checkout with a nickname, no sign-up | `app/(attendee)/v/[venueSlug]` |
| DJ | Request queue on a tablet: approve, reject, min prices, pause, block genres | `app/(staff)/dj` |
| Hype man (MC) | Phone view: queued MC shoutouts, big-spray alerts | `app/(staff)/mc` |
| Club | Big-screen page on a TV/laptop + manager dashboard (prices, splits, approvals, earnings, invite links) | `app/(screen)/s/[venueSlug]`, `app/(staff)/club` |
| Admin (us) | Onboard venues, DJs, MCs; refunds; disputes | `app/(admin)/admin` |

DJs and MCs have one account each and work at many venues. A night can have **several DJ sets** (and MC changes), so money is attributed to whoever was on the active set when the payment was confirmed (see Lineups below). Clubs themselves are admin-approved.

## Staff onboarding and venue discovery

DJs and MCs become staff at a venue in one of two ways; both end with an `active` row in `venue_staff`.

**1. Club invites (no approval needed)**
- Manager → Staff → Invite → picks role (`dj` | `mc`), optional name → gets a link (shareable on WhatsApp) and a QR code.
- Invites are single-use, expire after 7 days, have a fixed role, and can be cancelled before use.
- New user: sign up (phone OTP), real name, stage name, bank account → Bachs recipient account created; payouts go live once the bank account resolves. Existing user: log in → Accept.
- Phone OTP is sent by Termii through Supabase's Send SMS auth hook. Locally, use Supabase test OTPs (no SMS sent).
- Accepting creates `venue_staff` with status `active`.

**2. DJ/MC requests to join (club approves)**
- DJ dashboard → **Find venues**: a directory of venues that are `active` AND `listed`, searchable by name, filterable by city and area.
- Venue card/profile shows public info only: name, city/area, nights it runs, music style, whether it's accepting DJ/MC requests. Never earnings, staff details or attendee data.
- **Request to join**: choose role + optional note. Only allowed when the venue has `accepting_staff_requests = true`. One pending request per profile per venue (rate-limit).
- Shortcuts: enter the venue's `staff_join_code`, or scan the staff QR at the DJ booth → creates the same request for that venue (works even if the venue is unlisted).
- Manager approves or declines in the club dashboard (in-app notification for the MVP; WhatsApp/SMS later). Approve → `venue_staff` `active`.
- DJ/MC sees requests under **My venues** as pending / approved / declined.

**Venue listing controls (club manager):** `listed` on/off (hidden venues use only invites, join code and booth QR) and `accepting_staff_requests` on/off.

**Other rules**
- Club can remove a DJ/MC at any time; earnings already owed are still paid.
- DJ/MC can leave a venue.
- Only the DJ/MC can view or change their own bank details, with a phone OTP check. Clubs never see them.
- Admin can suspend any profile across all venues.
- Club managers sign in with phone OTP and are created by admin (`venue_staff.source = 'admin'`) for the pilot.
- The club's payout bank account belongs to the venue (not to a manager). Admin sets and verifies it; managers can't change it without admin approval.

## Lineups (who gets paid tonight)

- Being staff at a venue doesn't mean earning every night. Before each night the manager sets the lineup as **sets**: DJ and/or MC with start and end times.
- Backup: a DJ/MC scans the booth QR to "clock in"; the manager confirms, which opens a set.
- **No overlapping sets of the same role** at a venue: at most one DJ set and one MC set at any moment, enforced by a database exclusion constraint on `venue_sets`. Back-to-back (end = next start) is fine.
- When a payment is confirmed (webhook), the order is attributed to the DJ and MC on the **active set at that moment** (`orders.dj_set_id` / `mc_set_id`), and their ledger shares go to them. If no DJ or MC set is active, that share goes to the club (configurable later). Exceptions:
  - **Song requests:** the DJ share is written **unassigned** (`profile_id` null) at payment and assigned to the DJ who marks the request played. Accepted-but-unplayed requests carry over to the next DJ's queue at changeover. Unplayed by the timeout → refunded as before. Only a DJ can mark a song played.
  - **MC shoutouts:** same rule for the MC share: unassigned at payment, assigned to the MC who marks it read. Only an MC can mark it read.
  - **Targeted sprays** (at a named DJ or MC) use a separate per-venue split, default **target 50 / club 40 / platform 10**, and the target's share goes to that person regardless of the current set. Untargeted sprays use the normal spray split. A spray can only target a DJ or MC who is active staff at the venue.

## Stack

- Next.js (App Router) + TypeScript (strict) + Tailwind CSS + shadcn/ui
- CSS animations for spray/shoutout motion (Framer Motion or Lottie only if CSS isn't enough; never on attendee routes)
- Supabase: Postgres, Realtime (one channel per venue), Auth (staff only, phone OTP), Row Level Security
- Payments: Bachs REST API called with `fetch` from `lib/payments/bachs.ts` (the docs name no official Node SDK). Docs: https://docs.bachs.io (index: https://docs.bachs.io/llms.txt)
- SMS: Termii via Supabase's Send SMS auth hook
- Background jobs: Supabase cron to start (refund timeouts, nightly settlement)
- Hosting: Vercel; Supabase in an EU region; Cloudflare for DNS
- Monitoring: Sentry; analytics: PostHog
- Tests: Vitest for unit/integration (money logic first), Playwright later for key flows

## Money rules (non-negotiable)

1. **Webhooks are the only proof of payment.** Never mark an order paid from a client redirect or client event. Bachs `collection.succeeded` (verify the signature) → mark paid.
2. **Webhook handling is idempotent.** Store the Bachs event/collection ID with a unique constraint; processing the same event twice must not create duplicate ledger entries.
3. **The ledger is the source of truth** for who is owed what. Every paid order writes `ledger_entries` (one per party: club, dj, mc, platform) inside a single DB transaction. Shares must sum exactly to the amount paid.
4. **Money is a decimal string + ISO currency** (e.g. `"2000.00"`, `"NGN"`), matching the Bachs API. Never floats. In Postgres use `numeric(14,2)`. Never minor units in API calls to Bachs.
5. **Never hold customer balances / no wallets.** Every payment flows through Bachs; we only record shares.
6. **Settle after closing, not per payment.** A nightly job transfers each party's share to their Bachs connected (recipient) account in one transfer per party per night. Refunds are taken from the ledger before settlement.
7. **Every external payment call uses an `Idempotency-Key`** and stores the returned IDs.
8. **All Bachs calls go through `lib/payments/`** (a small provider interface) so we can switch to Paystack/Flutterwave later. No Bachs API calls or Bachs-specific types outside that folder.
9. **Secrets live in `.env.local`** and server code only. Never expose secret keys to the browser. Build against the Bachs sandbox (`sk_sandbox_` keys) until told otherwise.
10. Money code always ships with tests.
11. **Splits are computed in whole kobo** in Postgres (`compute_split`): each party gets its basis-point share rounded down; leftover kobo goes to the platform; a DJ/MC share with nobody on the active set goes to the club.
12. **Unassigned shares are never paid out.** A DJ/MC share with `profile_id` null (song request not yet played, MC shoutout not yet read) is excluded from settlement until it's assigned, and is reversed if the order is refunded.
13. **The customer pays Bachs's processing fee** (`customer_bears_fee: true`), so the ledger splits the full order amount.

## Multi-club isolation

- Every venue-scoped table has `venue_id`.
- RLS policies enforce that staff only read/write rows for venues they're assigned to; attendees (anonymous) can only create orders and read public venue data.
- Never rely on application code alone for isolation.

## Data model (draft — refine in migrations)

- `venues` — id, slug, name, address, city, area, nights, music_style, status (`pending` | `active` | `suspended`), `listed` (bool), `accepting_staff_requests` (bool), `staff_join_code` (unique), currency, request timeout minutes
- `venue_pricing` — public, per order type: enabled, min_amount (the DJ controls song requests)
- `venue_splits` — private, per order type: club/dj/mc/platform basis points (sum 10000)
- `venue_target_splits` — private, per venue: target/club/platform basis points for targeted sprays (default 5000/4000/1000)
- `profiles` — id (auth user), real name, stage name, role(s), phone (verified)
- `payout_accounts` — owner is a venue (club share; set by admin) or a profile (DJ/MC); provider, recipient_id, status. Provider-neutral.
- `venue_staff` — venue_id, profile_id, role (`club_manager` | `dj` | `mc`), source (`invite` | `request` | `admin`), status (`active` | `removed` | `left`), joined_at, ended_at
- `invites` — venue_id, role, token (unique), invitee_name, created_by, expires_at, cancelled_at, accepted_by, accepted_at
- `staff_requests` — venue_id, profile_id, role, note, status (`pending` | `approved` | `declined` | `withdrawn`), decided_by, decided_at; unique pending per (venue_id, profile_id)
- `venue_nights` — venue_id, date, opened_at, closed_at, settled_at
- `venue_sets` — venue_id, venue_night_id, profile_id, role (`dj` | `mc`), starts_at, ends_at (null = still on), source (`lineup` | `clock_in`), confirmed_by; exclusion constraint: no overlapping sets of the same role per venue
- `orders` — venue_id, venue_night_id, type (`spray` | `screen_shoutout` | `mc_shoutout` | `song_request`), nickname, message, song fields, amount, currency, status (`pending_payment` | `paid` | `approved` | `rejected` | `fulfilled` | `refunded` | `expired`), spray_target (`dj` | `mc`) + target_profile_id (targeted sprays only; null = untargeted), dj_set_id and mc_set_id (set active when paid), created_at
- `payments` — order_id, provider, provider_checkout_id, provider_collection_id (unique), amount, currency, status, raw payload
- `ledger_entries` — order_id, venue_night_id, party (`club` | `dj` | `mc` | `platform`), profile_id (null on a dj/mc share = unassigned), amount, currency, kind (`share` | `refund_reversal`), assigned_at, assigned_by. Append-only; the one allowed update is assigning an unassigned share.
- `refunds` — order_id, provider_refund_id, amount, status, reason
- `payouts` — venue_night_id, profile_id, amount, provider_payout_id, idempotency_key, status
- `webhook_events` — provider_event_id (unique), type, received_at, processed_at, error (set when an event needs admin review)

## Product rules

- DJ always has final say: can reject any request; nothing is forced to play.
- Song requests not accepted/played within the venue's timeout are refunded automatically.
- All shoutouts pass a word filter and human approval before reaching the screen or the mic.
- Leaderboard shows **nicknames only**; amounts hidden by default; easy opt-out. Never show real full names next to amounts (safety: big spenders can become targets).

## Design rules

- **Dark mode by default** everywhere (clubs are dark).
- Attendee flow: big tap targets, minimal steps (scan → choose → amount → pay), works on weak signal. Keep attendee pages very light: no heavy libraries on those routes.
- Club screen: read from across a room — huge type, few words, bold motion, stylised money (not exact naira note replicas).
- Copy voice on screen and MC views: hype-man energy, Nigerian flavour, never cheesy or offensive ("Table 7 don scatter the place! ₦50k spray!"). Receipts and refund messages: plain and clear.
- Currency always formatted as `₦` with thousands separators.

## Conventions

- Server-only code in `lib/server/`; payment provider code in `lib/payments/`; Supabase clients in `lib/supabase/`.
- Database changes only via Supabase migrations in `supabase/migrations/`.
- Validate all input with Zod at API boundaries.
- Small, focused PRs/commits. Run typecheck, lint and tests before saying a task is done.

## Out of scope for the MVP

Native apps, wallets/stored balances, loyalty, song battles, artist-paid plays, brand sponsorships, DJ software integrations, Bluetooth/offline mode, back-to-back (shared) DJ/MC sets, spraying non-staff celebrants. Don't build these unless asked.

## Build order

1. Scaffold: Next.js + TS + Tailwind + shadcn/ui, Supabase project and local dev, Vitest, env setup.
2. Schema + RLS + migrations; ledger split function with tests.
3. Bachs sandbox: create checkout → webhook → order paid → ledger entries (end-to-end test).
4. Attendee venue page (QR landing) and checkout.
5. Realtime: DJ queue, MC view, club screen.
6. Lineups and attribution: `venue_sets`, unassigned song-request/MC-shoutout shares, targeted sprays (before settlement, so settlement is built once).
7. Refund timeout job, nightly settlement and payouts to connected accounts.
8. Staff onboarding: phone OTP (Termii), invites, venue directory, join requests, join code/booth QR, lineup scheduling and clock-in.
9. Admin: approve venues, venue payout accounts, suspend profiles, refunds, disputes.
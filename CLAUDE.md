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

DJs and MCs have one account each and are assigned to a venue per night (`venue_nights`). Clubs invite DJs/MCs via invite links; clubs themselves are admin-approved.

## Stack

- Next.js (App Router) + TypeScript (strict) + Tailwind CSS + shadcn/ui
- Framer Motion (or Lottie) for spray/shoutout animations
- Supabase: Postgres, Realtime (one channel per venue), Auth (staff only), Row Level Security
- Payments: Bachs (`@bachs/sdk`, Node). Docs: https://docs.bachs.io
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
8. **All Bachs calls go through `lib/payments/`** (a small provider interface) so we can switch to Paystack/Flutterwave later. No Bachs SDK imports outside that folder.
9. **Secrets live in `.env.local`** and server code only. Never expose secret keys to the browser. Build against the Bachs sandbox (`sk_sandbox_` keys) until told otherwise.
10. Money code always ships with tests.

## Multi-club isolation

- Every venue-scoped table has `venue_id`.
- RLS policies enforce that staff only read/write rows for venues they're assigned to; attendees (anonymous) can only create orders and read public venue data.
- Never rely on application code alone for isolation.

## Data model (draft — refine in migrations)

- `venues` — id, slug, name, address, status (`pending` | `active` | `suspended`), split config, min prices, request timeout minutes
- `profiles` — id (auth user), display name, role(s), Bachs connected account id, payout status
- `venue_staff` — venue_id, profile_id, role (`club_manager` | `dj` | `mc`), invited_by, status
- `invites` — venue_id, role, token, expires_at, accepted_by
- `venue_nights` — venue_id, date, dj_profile_id, mc_profile_id, opened_at, closed_at, settled_at
- `orders` — venue_id, venue_night_id, type (`spray` | `screen_shoutout` | `mc_shoutout` | `song_request`), nickname, message, song fields, amount, currency, status (`pending_payment` | `paid` | `approved` | `rejected` | `fulfilled` | `refunded` | `expired`), target (for sprays), created_at
- `payments` — order_id, provider, provider_checkout_id, provider_collection_id (unique), amount, currency, status, raw payload
- `ledger_entries` — order_id, venue_night_id, party (`club` | `dj` | `mc` | `platform`), profile_id, amount, currency, kind (`share` | `refund_reversal`)
- `refunds` — order_id, provider_refund_id, amount, status, reason
- `payouts` — venue_night_id, profile_id, amount, provider_payout_id, idempotency_key, status
- `webhook_events` — provider_event_id (unique), type, received_at, processed_at

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

Native apps, wallets/stored balances, loyalty, song battles, artist-paid plays, brand sponsorships, DJ software integrations, Bluetooth/offline mode. Don't build these unless asked.

## Build order

1. Scaffold: Next.js + TS + Tailwind + shadcn/ui, Supabase project and local dev, Vitest, env setup.
2. Schema + RLS + migrations; ledger split function with tests.
3. Bachs sandbox: create checkout → webhook → order paid → ledger entries (end-to-end test).
4. Attendee venue page (QR landing) and checkout.
5. Realtime: DJ queue, MC view, club screen.
6. Refund timeout job, nightly settlement and payouts to connected accounts.
7. Admin: onboard venue/DJ/MC, invites, refunds.
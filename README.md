# Nightlife

Spray, shoutouts and song requests for Nigerian nightclubs. See [CLAUDE.md](CLAUDE.md) for the product, money rules and conventions.

## Local development

Requires Node 22+ and Docker (for local Supabase).

```bash
npm install
cp .env.example .env.local   # then fill in values
npm run db:start             # starts local Supabase; copy keys from `npm run db:status`
npm run dev                  # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run check` | typecheck + lint + unit tests + DB tests (run before calling a task done) |
| `npm test` / `npm run test:db` | unit tests / database tests (DB tests need local Supabase running) |
| `npm run db:migration <name>` | new migration in `supabase/migrations/` |
| `npm run db:reset` | rebuild local DB from migrations + `supabase/seed.sql` |
| `npm run db:types` | regenerate `lib/supabase/database.types.ts` |
| `npm run db:stop` | stop local Supabase |
| `npm run db:demo` | add a batch of paid demo orders to Test Lounge (song requests, shoutouts, sprays) |
| `npm run db:jobs` | point pg_cron's refund worker at the dev server (run automatically by `db:reset`) |

## Local logins

`npm run db:reset` seeds an active venue, **Test Lounge** (`/v/test-lounge`), with tonight open and DJ Test + MC Test on their sets.

Sign in at `/login` with the **phone number and code `123456`** (test numbers: no SMS is sent), or open "Use email and password instead" (password `password123`):

| Phone | Email | Role |
| --- | --- | --- |
| `0800 000 0001` | `admin@test.local` | platform admin |
| `0800 000 0002` | `manager@test.local` | club manager |
| `0800 000 0003` | `dj@test.local` | DJ (on the decks) |
| `0800 000 0004` | `mc@test.local` | MC (on the mic) |
| `0800 000 0005` | `dj2@test.local` | second DJ (for changeovers) |
| `0800 000 0099` | (none) | spare number: sign up through an invite link as a new DJ/MC |

**Invites:** as the manager, `/club` → Staff → Create invite. Open the link in a private window and sign up with `0800 000 0099` / `123456`.
Any other number gets a real code; locally it's printed in the `npm run dev` console as `[dev sms] OTP for …`.

## Payments locally (Bachs sandbox)

Needs the Bachs CLI (`brew install bachsdev/bachs/bachs`, then `bachs login --sandbox`).

```bash
bachs listen --forward-to localhost:3000/api/webhooks/bachs
# copy the printed whsec_... into .env.local as BACHS_WEBHOOK_SECRET, restart `npm run dev`
bachs trigger collection.succeeded   # sends a signed test event
```

Bachs rejects `localhost` checkout return URLs, so to go through a real checkout set
`NEXT_PUBLIC_APP_URL` to a public tunnel URL (e.g. `cloudflared tunnel --url http://localhost:3000`).
Webhooks that can't be applied (unknown order, wrong amount, underpayment) are kept in
`webhook_events` with an `error` for review; `bachs events replay <evt_id>` reprocesses one.

## Background jobs

`pg_cron` runs every minute: song requests not played within the venue's timeout are rejected and refunded,
unpaid orders expire after 45 minutes, and pending refunds are sent to Bachs by calling `/api/jobs/refunds`
(new refunds wait a minute first). Locally the refund worker reaches your dev server at `host.docker.internal:3000`,
so keep `npm run dev` running. Refunds of the demo orders fail at Bachs ("Charge not found") because their
charges are made up: that's expected.

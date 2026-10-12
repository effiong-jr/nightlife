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

## Local logins

`npm run db:reset` seeds an active venue, **Test Lounge** (`/v/test-lounge`), with tonight open. All passwords are `password123`:

| Email | Role |
| --- | --- |
| `admin@test.local` | platform admin |
| `manager@test.local` | club manager |
| `dj@test.local` | DJ on duty |
| `mc@test.local` | MC on duty |

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

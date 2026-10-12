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
| `npm run check` | typecheck + lint + tests (run before calling a task done) |
| `npm run db:migration <name>` | new migration in `supabase/migrations/` |
| `npm run db:reset` | rebuild local DB from migrations + `supabase/seed.sql` |
| `npm run db:types` | regenerate `lib/supabase/database.types.ts` |
| `npm run db:stop` | stop local Supabase |

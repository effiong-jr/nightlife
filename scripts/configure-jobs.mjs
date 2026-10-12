// Local dev only: tells pg_cron where to call the refund worker.
// Stores Vault secrets `app_url` (the dev server, as seen from Docker) and
// `cron_secret` (CRON_SECRET from .env.local). Runs after `npm run db:reset`.
//
// Production: run once in the Supabase SQL editor instead:
//   select vault.create_secret('https://<your-domain>', 'app_url');
//   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
import pg from "pg";

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET missing from .env.local");
  process.exit(1);
}
const appUrl = process.env.JOBS_APP_URL ?? "http://host.docker.internal:3000";
const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
await client.connect();
for (const [name, value] of [
  ["app_url", appUrl],
  ["cron_secret", secret],
]) {
  const { rows } = await client.query("select id from vault.secrets where name = $1", [name]);
  if (rows[0]) await client.query("select vault.update_secret($1, $2)", [rows[0].id, value]);
  else await client.query("select vault.create_secret($1, $2)", [value, name]);
}
await client.end();
console.log(`Jobs configured: refund worker at ${appUrl}/api/jobs/refunds`);

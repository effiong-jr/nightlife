// Helpers for database tests against local Supabase (`npm run db:start`).
//
// Each test runs inside a transaction that is always rolled back, so tests never
// leave data behind. Setup runs as the `postgres` superuser (bypasses RLS);
// `as()` switches to anon or an authenticated user the same way PostgREST does,
// so RLS and grants apply exactly as they would for real requests.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll } from "vitest";

// pg returns numeric as strings by default; keep it that way (money is never a float).
const pool = new pg.Pool({
  connectionString:
    process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

export type Db = pg.PoolClient;

export async function withTx(fn: (db: Db) => Promise<void>): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await fn(db);
  } finally {
    await db.query("rollback");
    db.release();
  }
}

export type Who = "anon" | { userId: string };

// Runs fn as anon or a signed-in user inside a savepoint, then rolls back to the
// savepoint: the role switch and any writes are undone and the transaction
// stays usable even if fn's last statement failed.
export async function as<T>(db: Db, who: Who, fn: () => Promise<T>): Promise<T> {
  const savepoint = `as_${randomUUID().replaceAll("-", "")}`;
  const claims =
    who === "anon" ? { role: "anon" } : { sub: who.userId, role: "authenticated" };
  await db.query(`savepoint ${savepoint}`);
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await db.query(`set local role ${who === "anon" ? "anon" : "authenticated"}`);
    return await fn();
  } finally {
    await db.query(`rollback to savepoint ${savepoint}`);
  }
}

// Forces deferred constraints (e.g. the ledger balance check) to run now, as
// they would at commit.
export async function checkDeferred(db: Db): Promise<void> {
  await db.query("set constraints all immediate");
}

// Test data builders. All run as postgres inside the test transaction.
import { randomUUID } from "node:crypto";
import type { Db } from "./db";

type OrderType = "spray" | "screen_shoutout" | "mc_shoutout" | "song_request";
type StaffRole = "club_manager" | "dj" | "mc";

export async function createUser(db: Db, opts: { isAdmin?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into auth.users (instance_id, id, aud, role, email)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2)`,
    [id, `${id}@test.local`],
  );
  if (opts.isAdmin) {
    await db.query("update public.profiles set is_admin = true where id = $1", [id]);
  }
  return id;
}

export type Split = { club: number; dj: number; mc: number; platform: number };

export const DEFAULT_SPLIT: Split = { club: 4000, dj: 2500, mc: 2500, platform: 1000 };

export async function createVenue(
  db: Db,
  opts: { status?: "pending" | "active" | "suspended"; split?: Split; minAmount?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const split = opts.split ?? DEFAULT_SPLIT;
  await db.query(
    "insert into public.venues (id, slug, name, status) values ($1, $2, 'Test Venue', $3)",
    [id, `venue-${id}`, opts.status ?? "active"],
  );
  for (const type of ["spray", "screen_shoutout", "mc_shoutout", "song_request"] satisfies OrderType[]) {
    await db.query(
      "insert into public.venue_pricing (venue_id, order_type, min_amount) values ($1, $2, $3)",
      [id, type, opts.minAmount ?? "1000.00"],
    );
    await db.query(
      `insert into public.venue_splits (venue_id, order_type, club_bps, dj_bps, mc_bps, platform_bps)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, type, split.club, split.dj, split.mc, split.platform],
    );
  }
  return id;
}

export async function addStaff(db: Db, venueId: string, profileId: string, role: StaffRole) {
  await db.query(
    "insert into public.venue_staff (venue_id, profile_id, role) values ($1, $2, $3)",
    [venueId, profileId, role],
  );
}

export async function openNight(
  db: Db,
  venueId: string,
  opts: { djId?: string | null; mcId?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.venue_nights (venue_id, night_date, dj_profile_id, mc_profile_id, opened_at)
     values ($1, current_date, $2, $3, now()) returning id`,
    [venueId, opts.djId ?? null, opts.mcId ?? null],
  );
  return rows[0].id;
}

// A venue with a manager, DJ and MC on duty tonight.
export async function createStaffedVenue(db: Db, opts: { split?: Split } = {}) {
  const venueId = await createVenue(db, opts);
  const managerId = await createUser(db);
  const djId = await createUser(db);
  const mcId = await createUser(db);
  await addStaff(db, venueId, managerId, "club_manager");
  await addStaff(db, venueId, djId, "dj");
  await addStaff(db, venueId, mcId, "mc");
  const nightId = await openNight(db, venueId, { djId, mcId });
  return { venueId, managerId, djId, mcId, nightId };
}

export type OrderInput = {
  venueId: string;
  nightId: string;
  type?: OrderType;
  amount?: string;
  status?: "pending_payment" | "paid" | "expired";
};

export async function createOrder(db: Db, o: OrderInput): Promise<string> {
  const type = o.type ?? "spray";
  const status = o.status ?? "pending_payment";
  const { rows } = await db.query<{ id: string }>(
    `insert into public.orders
       (venue_id, venue_night_id, type, status, nickname, message, song_title, spray_target, amount, paid_at)
     values ($1, $2, $3, $4, 'Table 7', $5, $6, $7, $8, $9)
     returning id`,
    [
      o.venueId,
      o.nightId,
      type,
      status,
      type === "screen_shoutout" || type === "mc_shoutout" ? "Happy birthday Tolu!" : null,
      type === "song_request" ? "Ojuelegba" : null,
      type === "spray" ? "dj" : null,
      o.amount ?? "2000.00",
      status === "paid" ? new Date() : null,
    ],
  );
  return rows[0].id;
}

// Calls record_paid_order as the webhook handler would (service_role).
export async function recordPaid(
  db: Db,
  orderId: string,
  opts: { eventId?: string; amount?: string; currency?: string } = {},
): Promise<string> {
  const { rows: order } = await db.query<{ amount: string }>(
    "select amount from public.orders where id = $1",
    [orderId],
  );
  const { rows } = await db.query<{ result: string }>(
    `select public.record_paid_order(
       'bachs', $1, 'collection.succeeded', '{}'::jsonb, $2, null, $3, $4, $5
     ) as result`,
    [
      opts.eventId ?? `evt_${randomUUID()}`,
      orderId,
      `col_${randomUUID()}`,
      opts.amount ?? order[0]?.amount ?? "0",
      opts.currency ?? "NGN",
    ],
  );
  return rows[0].result;
}

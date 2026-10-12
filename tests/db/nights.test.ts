// Opening and closing nights.
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { createOrder, createStaffedVenue, createVenue, recordPaid } from "./fixtures";

async function status(db: Db, orderId: string) {
  const { rows } = await db.query(
    "select o.status, r.reason as refund_reason from public.orders o left join public.refunds r on r.order_id = o.id where o.id = $1",
    [orderId],
  );
  return rows[0];
}

async function asKeeping<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await db.query("set local role authenticated");
  try {
    return await fn();
  } finally {
    await db.query("reset role");
  }
}

describe("opening a night", () => {
  it("uses the Lagos business day (until 06:00) and allows one open night", async () => {
    await withTx(async (db) => {
      const { rows } = await db.query(
        `select public.business_date('2026-10-12 22:00+01')::text as evening,
                public.business_date('2026-10-13 03:30+01')::text as small_hours,
                public.business_date('2026-10-13 07:00+01')::text as morning`,
      );
      expect(rows[0]).toEqual({ evening: "2026-10-12", small_hours: "2026-10-12", morning: "2026-10-13" });

      const v = await createStaffedVenue(db); // fixture night already open
      await as(db, { userId: v.managerId }, () =>
        expect(db.query("select public.open_night($1)", [v.venueId])).rejects.toThrow(/already open/),
      );
    });
  });

  it("only managers can open, and a night closed by mistake can be reopened", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("update public.venue_nights set closed_at = now() where id = $1", [v.nightId]);
      await db.query("update public.venue_nights set night_date = public.business_date() where id = $1", [v.nightId]);

      await as(db, { userId: v.djId }, () =>
        expect(db.query("select public.open_night($1)", [v.venueId])).rejects.toThrow(/only a manager/),
      );
      const reopened = await asKeeping(db, v.managerId, async () => {
        const { rows } = await db.query("select public.open_night($1) as id", [v.venueId]);
        return rows[0].id;
      });
      expect(reopened).toBe(v.nightId);
      const { rows } = await db.query("select closed_at from public.venue_nights where id = $1", [v.nightId]);
      expect(rows[0].closed_at).toBeNull();
    });
  });

  it("opens a fresh night for a venue with none tonight", async () => {
    await withTx(async (db) => {
      const venueId = await createVenue(db);
      const v = await createStaffedVenue(db); // a manager, made manager of this venue too
      await db.query("insert into public.venue_staff (venue_id, profile_id, role) values ($1, $2, 'club_manager')", [
        venueId,
        v.managerId,
      ]);
      const id = await asKeeping(db, v.managerId, async () => {
        const { rows } = await db.query("select public.open_night($1) as id", [venueId]);
        return rows[0].id;
      });
      const { rows } = await db.query(
        "select night_date = public.business_date() as today, opened_at is not null as open from public.venue_nights where id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ today: true, open: true });
    });
  });
});

describe("closing a night", () => {
  it("ends sets, refunds what can't happen now, and keeps what's done", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const make = async (type: "spray" | "song_request" | "mc_shoutout" | "screen_shoutout", then?: string) => {
        const id = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type });
        await recordPaid(db, id);
        if (then) await db.query("update public.orders set status = $2 where id = $1", [id, then]);
        return id;
      };
      const spray = await make("spray");
      const unplayed = await make("song_request", "approved");
      const played = await make("song_request", "fulfilled");
      const unread = await make("mc_shoutout");
      const unapproved = await make("screen_shoutout");
      const shown = await make("screen_shoutout", "approved");

      const refunded = await asKeeping(db, v.managerId, async () => {
        const { rows } = await db.query("select public.close_night($1) as n", [v.nightId]);
        return rows[0].n;
      });
      expect(refunded).toBe(3);

      expect(await status(db, spray)).toEqual({ status: "paid", refund_reason: null });
      expect(await status(db, played)).toEqual({ status: "fulfilled", refund_reason: null });
      expect(await status(db, shown)).toEqual({ status: "fulfilled", refund_reason: null });
      for (const id of [unplayed, unread, unapproved]) {
        expect(await status(db, id)).toEqual({ status: "rejected", refund_reason: "night_closed" });
      }
      const { rows: sets } = await db.query(
        "select count(*)::int as open from public.venue_sets where venue_night_id = $1 and ends_at is null",
        [v.nightId],
      );
      expect(sets[0].open).toBe(0);

      // Ordering stops.
      await as(db, "anon", () =>
        expect(
          db.query(
            "insert into public.orders (venue_id, venue_night_id, type, nickname, amount, currency) values ($1, $2, 'spray', 'Late', '2000.00', 'NGN')",
            [v.venueId, v.nightId],
          ),
        ).rejects.toThrow(/row-level security/),
      );
    });
  });

  it("refunds a payment that lands after the night closed", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray" });
      await db.query("select public.close_night($1)", [v.nightId]);
      expect(await recordPaid(db, order)).toBe("recorded_late_refunding");
      expect(await status(db, order)).toEqual({ status: "rejected", refund_reason: "late_payment" });
    });
  });

  it("only managers of the venue can close; the 06:00 job closes the rest", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      for (const userId of [a.djId, b.managerId]) {
        await as(db, { userId }, () =>
          expect(db.query("select public.close_night($1)", [a.nightId])).rejects.toThrow(/only a manager/),
        );
      }
      await db.query("select public.auto_close_nights()");
      const { rows } = await db.query(
        "select count(*)::int as open from public.venue_nights where id = any($1) and closed_at is null",
        [[a.nightId, b.nightId]],
      );
      expect(rows[0].open).toBe(0);
    });
  });
});

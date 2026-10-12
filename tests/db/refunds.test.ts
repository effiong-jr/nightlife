// Refunds: rejection -> refund + ledger reversals, the timeout and expiry jobs,
// late payments, provider outcomes, and the worker's claim.
import { describe, expect, it } from "vitest";
import { as, checkDeferred, type Db, withTx } from "./db";
import { createOrder, createStaffedVenue, recordPaid } from "./fixtures";

async function refundsFor(db: Db, orderId: string) {
  const { rows } = await db.query<{ id: string; status: string; reason: string; amount: string }>(
    "select id, status, reason, amount::text from public.refunds where order_id = $1 order by created_at",
    [orderId],
  );
  return rows;
}

async function ledgerNet(db: Db, orderId: string) {
  const { rows } = await db.query(
    `select kind, count(*)::int as n, sum(amount)::text as total from public.ledger_entries
     where order_id = $1 group by kind order by kind`,
    [orderId],
  );
  return rows;
}

async function settlement(db: Db, nightId: string) {
  const { rows } = await db.query(
    "select party, amount::text from public.night_settlement_amounts($1) order by party",
    [nightId],
  );
  return rows;
}

async function orderStatus(db: Db, orderId: string): Promise<string> {
  const { rows } = await db.query("select status from public.orders where id = $1", [orderId]);
  return rows[0].status;
}

// Runs as a user and keeps the writes (as() always rolls back).
async function asKeeping(db: Db, userId: string, sql: string, params: unknown[]) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await db.query("set local role authenticated");
  try {
    return await db.query(sql, params);
  } finally {
    await db.query("reset role");
  }
}

describe("rejection refunds", () => {
  it("a staff rejection creates a pending refund and reverses every share", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const song = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request", amount: "10000.00" });
      await recordPaid(db, song);
      await asKeeping(db, v.djId, "update public.orders set status = 'rejected' where id = $1", [song]);
      await checkDeferred(db);

      expect(await refundsFor(db, song)).toMatchObject([{ status: "pending", reason: "rejected_by_staff", amount: "10000.00" }]);
      // Four shares (including the unassigned DJ share) and four reversals.
      expect(await ledgerNet(db, song)).toEqual([
        { kind: "share", n: 4, total: "10000.00" },
        { kind: "refund_reversal", n: 4, total: "-10000.00" },
      ]);
      // Nothing from this order is ever paid out.
      expect(await settlement(db, v.nightId)).toEqual([]);
    });
  });

  it("is idempotent: one live refund and one set of reversals per order", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "mc_shoutout" });
      await recordPaid(db, order);
      await db.query("update public.orders set status = 'rejected' where id = $1", [order]);
      const [first] = await refundsFor(db, order);
      const { rows } = await db.query("select public.request_refund($1, 'admin') as id", [order]);
      expect(rows[0].id).toBe(first.id);

      // After a failure, a new attempt gets a new refund but no second reversal.
      await db.query("select public.record_refund_status($1, 'failed', null, 'card declined')", [first.id]);
      await db.query("select public.request_refund($1, 'admin')", [order]);
      expect((await refundsFor(db, order)).map((r) => r.status)).toEqual(["failed", "pending"]);
      expect((await ledgerNet(db, order)).find((r) => r.kind === "refund_reversal")).toMatchObject({ n: 4 });
    });
  });

  it("can't be triggered by staff or attendees directly", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, order);
      for (const sql of ["select public.request_refund($1, 'admin')", "select * from public.claim_due_refunds(5, $1)"]) {
        await as(db, { userId: v.managerId }, () => expect(db.query(sql, [order])).rejects.toThrow(/permission denied/));
      }
    });
  });
});

describe("scheduled jobs", () => {
  it("refunds song requests not played within the venue's timeout", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // timeout: 30 minutes
      const make = async (minutesAgo: number, status?: string) => {
        const id = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request" });
        await recordPaid(db, id);
        if (status) await db.query("update public.orders set status = $2 where id = $1", [id, status]);
        await db.query("update public.orders set paid_at = now() - make_interval(mins => $2) where id = $1", [id, minutesAgo]);
        return id;
      };
      const stale = await make(31);
      const staleAccepted = await make(45, "approved");
      const fresh = await make(10);
      const played = await make(60, "fulfilled");

      const { rows } = await db.query("select public.timeout_song_requests() as n");
      expect(rows[0].n).toBe(2);
      expect(await orderStatus(db, stale)).toBe("rejected");
      expect(await orderStatus(db, staleAccepted)).toBe("rejected");
      expect(await orderStatus(db, fresh)).toBe("paid");
      expect(await orderStatus(db, played)).toBe("fulfilled");
      expect(await refundsFor(db, stale)).toMatchObject([{ reason: "request_timeout", status: "pending" }]);
    });
  });

  it("expires orders that were never paid", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const old = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      const recent = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await db.query("update public.orders set created_at = now() - interval '46 minutes' where id = $1", [old]);
      await db.query("select public.expire_stale_orders()");
      expect(await orderStatus(db, old)).toBe("expired");
      expect(await orderStatus(db, recent)).toBe("pending_payment");
    });
  });
});

describe("late payments", () => {
  it("records a payment on an expired order, then refunds it without showing it on screen", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", status: "expired" });
      expect(await recordPaid(db, order)).toBe("recorded_late_refunding");
      await checkDeferred(db);

      expect(await orderStatus(db, order)).toBe("rejected");
      expect(await refundsFor(db, order)).toMatchObject([{ reason: "late_payment", status: "pending" }]);
      expect(await ledgerNet(db, order)).toEqual([
        { kind: "share", n: 4, total: "2000.00" },
        { kind: "refund_reversal", n: 4, total: "-2000.00" },
      ]);
      const { rows } = await db.query("select count(*)::int as n from realtime.messages where topic = $1", [`screen:${v.venueId}`]);
      expect(rows[0].n).toBe(0);
    });
  });
});

describe("refund outcomes", () => {
  it("a paid refund marks the order refunded; final states don't change", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, order);
      await db.query("update public.orders set status = 'rejected' where id = $1", [order]);
      const [refund] = await refundsFor(db, order);

      await db.query("select public.record_refund_status($1, 'processing', 'rfnd_1', null)", [refund.id]);
      await db.query("select public.record_refund_status($1, 'succeeded', 'rfnd_1', null)", [refund.id]);
      expect(await orderStatus(db, order)).toBe("refunded");
      await db.query("select public.record_refund_status($1, 'failed', 'rfnd_1', 'late failure')", [refund.id]);
      expect(await refundsFor(db, order)).toMatchObject([{ status: "succeeded" }]);
    });
  });

  it("waits a minute before the background worker sends it, and leases it once claimed", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, order);
      await db.query("update public.orders set status = 'rejected' where id = $1", [order]);
      const backgroundClaim = async () => {
        const { rows } = await db.query("select order_id from public.claim_due_refunds(100)");
        return rows.filter((r) => r.order_id === order);
      };

      // Grace period: the background worker doesn't see it yet.
      expect(await backgroundClaim()).toEqual([]);

      // Claiming this order directly skips the wait (admin "retry now").
      const claimed = await db.query("select * from public.claim_due_refunds(10, $1)", [order]);
      expect(claimed.rows).toHaveLength(1);
      expect(claimed.rows[0]).toMatchObject({ order_id: order, amount: "2000.00", attempts: 1 });
      expect(claimed.rows[0].charge_id).toMatch(/^col_/);

      // Once due, it's leased for 2 minutes after a claim: no double send.
      await db.query("update public.refunds set next_attempt_at = now() - interval '1 second' where order_id = $1", [order]);
      expect(await backgroundClaim()).toHaveLength(1);
      expect(await backgroundClaim()).toEqual([]);
    });
  });
});

// Nightly settlement: who gets a payout, holds and releases, the payout fee.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { addSet, addStaff, createOrder, createStaffedVenue, createUser, recordPaid } from "./fixtures";

async function payoutAccount(db: Db, owner: { venueId?: string; profileId?: string }, status = "active") {
  const recipient = `acct_${randomUUID().slice(0, 12)}`;
  await db.query(
    "insert into public.payout_accounts (venue_id, profile_id, provider, recipient_id, status) values ($1, $2, 'bachs', $3, $4)",
    [owner.venueId ?? null, owner.profileId ?? null, recipient, status],
  );
  return recipient;
}

async function payouts(db: Db, nightId: string) {
  const { rows } = await db.query(
    `select party, profile_id, amount::text, status, held_reason from public.payouts
     where venue_night_id = $1 order by party, amount desc`,
    [nightId],
  );
  return rows;
}

const close = (db: Db, nightId: string) => db.query("select public.close_night($1)", [nightId]);

describe("settle_night", () => {
  it("creates one payout per payee from the ledger, holding anyone without a payable account", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // spray split 40/25/25/10, DJ + MC on
      await payoutAccount(db, { venueId: v.venueId });
      await payoutAccount(db, { profileId: v.djId });
      await payoutAccount(db, { profileId: v.mcId }, "pending"); // still verifying
      const spray = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", amount: "20000.00" });
      await recordPaid(db, spray);
      await close(db, v.nightId);

      const { rows } = await db.query("select public.settle_night($1) as n", [v.nightId]);
      expect(rows[0].n).toBe(3);
      expect(await payouts(db, v.nightId)).toEqual([
        { party: "club", profile_id: null, amount: "8000.00", status: "pending", held_reason: null },
        { party: "dj", profile_id: v.djId, amount: "5000.00", status: "pending", held_reason: null },
        { party: "mc", profile_id: v.mcId, amount: "5000.00", status: "held", held_reason: "payout_account_not_ready" },
      ]);
      // The platform keeps its 2,000: no payout row.

      // Idempotent, and the night is marked settled.
      const again = await db.query("select public.settle_night($1) as n", [v.nightId]);
      expect(again.rows[0].n).toBe(0);
      const { rows: night } = await db.query("select settled_at is not null as settled from public.venue_nights where id = $1", [v.nightId]);
      expect(night[0].settled).toBe(true);
    });
  });

  it("refuses open nights, never pays refunded or unassigned money, and pays each DJ of the night separately", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db, { split: { club: 3000, dj: 6000, mc: 0, platform: 1000 } });
      await db.query("savepoint attempt");
      await expect(db.query("select public.settle_night($1)", [v.nightId])).rejects.toThrow(/still open/);
      await db.query("rollback to savepoint attempt");

      // DJ A earns a targeted spray; DJ B takes over and plays a song request.
      const djB = await createUser(db);
      await addStaff(db, v.venueId, djB, "dj");
      const spray = await createOrder(db, {
        venueId: v.venueId,
        nightId: v.nightId,
        type: "spray",
        amount: "10000.00",
        target: { role: "dj", profileId: v.djId },
      });
      await recordPaid(db, spray);
      const played = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request", amount: "5000.00" });
      const unplayed = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request", amount: "7000.00" });
      await recordPaid(db, played);
      await recordPaid(db, unplayed);
      await db.query("update public.venue_sets set ends_at = now() where venue_id = $1 and role = 'dj'", [v.venueId]);
      await addSet(db, { venueId: v.venueId, nightId: v.nightId, profileId: djB, role: "dj", startsAt: new Date(Date.now() + 1000).toISOString() });
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: djB, role: "authenticated" })]);
      await db.query("set local role authenticated");
      await db.query("update public.orders set status = 'fulfilled' where id = $1", [played]);
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");

      await close(db, v.nightId); // refunds the unplayed request
      await db.query("select public.settle_night($1)", [v.nightId]);
      const rows = await payouts(db, v.nightId);
      // Targeted spray 50/40/10: DJ A 5000, club 4000. Played song 30/60/10: club 1500, DJ B 3000.
      expect(rows.map((r) => [r.party, r.profile_id, r.amount])).toEqual([
        ["club", null, "5500.00"],
        ["dj", v.djId, "5000.00"],
        ["dj", djB, "3000.00"],
      ]);
      expect(rows.every((r) => r.held_reason === "no_payout_account")).toBe(true);
    });
  });

  it("holds shares too small to pay out after the fee", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db, { split: { club: 9900, dj: 50, mc: 50, platform: 0 } });
      await payoutAccount(db, { profileId: v.djId });
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "10000.00" });
      await recordPaid(db, order);
      await close(db, v.nightId);
      await db.query("select public.settle_night($1)", [v.nightId]);
      expect((await payouts(db, v.nightId)).find((r) => r.party === "dj")).toMatchObject({
        amount: "50.00",
        status: "held",
        held_reason: "below_minimum",
      });
    });
  });
});

describe("releasing held payouts", () => {
  it("releases a held payout as soon as the payee's account becomes payable", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const recipient = await payoutAccount(db, { profileId: v.mcId }, "pending");
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "4000.00" });
      await recordPaid(db, order);
      await close(db, v.nightId);
      await db.query("select public.settle_night($1)", [v.nightId]);
      expect((await payouts(db, v.nightId)).find((r) => r.party === "mc")?.status).toBe("held");

      await db.query("select public.record_payout_account_state('bachs', $1, true, true, '{}')", [recipient]);
      expect((await payouts(db, v.nightId)).find((r) => r.party === "mc")).toMatchObject({ status: "pending", held_reason: null });
    });
  });

  it("the worker's claim nets off the ₦50 payout fee, and results are final", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await payoutAccount(db, { profileId: v.djId });
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "10000.00" });
      await recordPaid(db, order);
      await close(db, v.nightId);
      await db.query("select public.settle_night($1)", [v.nightId]);
      const { rows: payout } = await db.query("select id from public.payouts where venue_night_id = $1 and party = 'dj'", [v.nightId]);

      const { rows } = await db.query("select * from public.claim_due_payouts(10, $1)", [payout[0].id]);
      expect(rows[0]).toMatchObject({ amount: "2500.00", net_amount: "2450.00", currency: "NGN", status: "pending" });

      await db.query("select public.record_payout_result('bachs', 'pay_1', $1, 'paid', null)", [payout[0].id]);
      await db.query("select public.record_payout_result('bachs', 'pay_1', $1, 'failed', 'late')", [payout[0].id]);
      const { rows: final } = await db.query("select status, paid_at is not null as paid from public.payouts where id = $1", [payout[0].id]);
      expect(final[0]).toEqual({ status: "paid", paid: true });
    });
  });

  it("isn't callable by staff", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await close(db, v.nightId);
      for (const sql of ["select public.settle_night($1)", "select * from public.claim_due_payouts(5, $1)"]) {
        await as(db, { userId: v.managerId }, () => expect(db.query(sql, [v.nightId])).rejects.toThrow(/permission denied/));
      }
    });
  });
});

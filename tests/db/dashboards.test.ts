// Club manager and DJ/MC dashboard numbers, and who may see them.
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { createOrder, createStaffedVenue, recordPaid } from "./fixtures";

async function asUser<T>(db: Db, userId: string, sql: string, params: unknown[]): Promise<T> {
  return as(db, { userId }, async () => {
    const { rows } = await db.query(sql, params);
    return rows[0].r as T;
  });
}

async function paidOrder(db: Db, v: { venueId: string; nightId: string }, amount: string, table: string, type = "spray") {
  const id = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount, type: type as "spray" });
  await db.query("update public.orders set table_label = $2 where id = $1", [id, table]);
  await recordPaid(db, id);
  return id;
}

describe("club_night_summary", () => {
  it("adds up tonight exactly, with the club's share after refunds and top tables", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // 40/25/25/10, DJ + MC on
      await paidOrder(db, v, "20000.00", "VIP 1");
      await paidOrder(db, v, "5000.00", "Table 7");
      await paidOrder(db, v, "5000.00", "Table 7");
      const refunded = await paidOrder(db, v, "10000.00", "Table 2", "song_request");
      await db.query("update public.orders set status = 'rejected' where id = $1", [refunded]);

      const s = await asUser<Record<string, unknown>>(db, v.managerId, "select public.club_night_summary($1) as r", [v.nightId]);
      expect(s).toMatchObject({
        gross: "40000.00",
        orders: 4,
        refunded: "10000.00",
        refundCount: 1,
        net: "30000.00",
        avgOrder: "10000.00",
        // 40% of the 30,000 kept.
        clubShare: "12000.00",
        staffShare: "15000.00",
      });
      // Refunded tables drop out; tables, never nicknames.
      expect(s.topTables).toEqual([
        { table: "VIP 1", orders: 1, gross: "20000.00" },
        { table: "Table 7", orders: 2, gross: "10000.00" },
      ]);
      expect((s.hourly as unknown[]).length).toBeGreaterThan(0);
    });
  });

  it("is for that venue's managers only", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      for (const userId of [a.djId, a.mcId, b.managerId]) {
        await expect(
          asUser(db, userId, "select public.club_night_summary($1) as r", [a.nightId]),
        ).rejects.toThrow(/only managers/);
        await expect(asUser(db, userId, "select public.club_history($1, 10) as r", [a.venueId])).rejects.toThrow(/only managers/);
      }
    });
  });
});

describe("club_history", () => {
  it("lists nights with the club's share and payout status, and what staff earned", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("insert into public.payout_accounts (venue_id, provider, recipient_id, status) values ($1, 'bachs', 'acct_club', 'active')", [
        v.venueId,
      ]);
      await paidOrder(db, v, "10000.00", "Table 1");
      await db.query("select public.close_night($1)", [v.nightId]);
      await db.query("select public.settle_night($1)", [v.nightId]);

      const h = await asUser<{ nights: Record<string, unknown>[]; staff: Record<string, unknown>[] }>(
        db,
        v.managerId,
        "select public.club_history($1, 10) as r",
        [v.venueId],
      );
      expect(h.nights[0]).toMatchObject({
        open: false,
        settled: true,
        orders: 1,
        gross: "10000.00",
        clubShare: "4000.00",
        staffShare: "5000.00",
        clubPayout: { amount: "4000.00", status: "pending" },
      });
      expect(h.staff.map((s) => [s.profileId, s.earned])).toEqual(
        expect.arrayContaining([
          [v.djId, "2500.00"],
          [v.mcId, "2500.00"],
        ]),
      );
    });
  });
});

describe("my_earnings", () => {
  it("shows a DJ only their own earnings, tonight and per night, with payout net of the fee", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("insert into public.payout_accounts (profile_id, provider, recipient_id, status) values ($1, 'bachs', 'acct_dj', 'active')", [
        v.djId,
      ]);
      await paidOrder(db, v, "10000.00", "Table 1");

      const tonight = await asUser<Record<string, unknown>>(db, v.djId, "select public.my_earnings(10) as r", []);
      expect(tonight).toMatchObject({ tonight: "2500.00", allTime: "2500.00", paidOut: "0.00" });

      await db.query("select public.close_night($1)", [v.nightId]);
      await db.query("select public.settle_night($1)", [v.nightId]);
      await db.query("update public.payouts set status = 'paid', paid_at = now() where profile_id = $1", [v.djId]);
      const after = await asUser<{ paidOut: string; nights: Record<string, unknown>[] }>(db, v.djId, "select public.my_earnings(10) as r", []);
      expect(after.paidOut).toBe("2450.00");
      expect(after.nights[0]).toMatchObject({
        open: false,
        earned: "2500.00",
        payout: { amount: "2500.00", fee: "50.00", net: "2450.00", status: "paid" },
      });

      // The MC sees their own figure, not the DJ's.
      const mc = await asUser<{ allTime: string }>(db, v.mcId, "select public.my_earnings(10) as r", []);
      expect(mc.allTime).toBe("2500.00");
      const nobody = await as(db, "anon", async () => (await db.query("select public.my_earnings(10) as r").catch((e) => ({ rows: [{ r: e.message }] }))).rows[0].r);
      expect(String(nobody)).toMatch(/permission denied/);
    });
  });
});

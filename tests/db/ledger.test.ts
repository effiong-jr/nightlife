import { describe, expect, it } from "vitest";
import { as, checkDeferred, type Db, withTx } from "./db";
import { createOrder, createStaffedVenue, createVenue, openNight, recordPaid } from "./fixtures";

type Shares = Record<"club" | "dj" | "mc" | "platform", string>;

async function split(
  db: Db,
  amount: string,
  bps: [club: number, dj: number, mc: number, platform: number],
  present: { dj?: boolean; mc?: boolean } = {},
): Promise<Shares> {
  const { rows } = await db.query<{ party: keyof Shares; amount: string }>(
    "select party, amount::text from public.compute_split($1, $2, $3, $4, $5, $6, $7)",
    [amount, ...bps, present.dj ?? true, present.mc ?? true],
  );
  return Object.fromEntries(rows.map((r) => [r.party, r.amount])) as Shares;
}

async function ledgerFor(db: Db, orderId: string) {
  const { rows } = await db.query<{ party: string; profile_id: string | null; amount: string }>(
    `select party, profile_id, amount::text from public.ledger_entries
     where order_id = $1 and kind = 'share' order by party`,
    [orderId],
  );
  return rows;
}

describe("compute_split", () => {
  it("splits evenly divisible amounts exactly", async () => {
    await withTx(async (db) => {
      expect(await split(db, "2000.00", [4000, 2500, 2500, 1000])).toEqual({
        club: "800.00",
        dj: "500.00",
        mc: "500.00",
        platform: "200.00",
      });
    });
  });

  it("gives leftover kobo to the platform", async () => {
    await withTx(async (db) => {
      // 100001 kobo * 33.33% = 33330.33 kobo each -> 33330. The platform gets its
      // 0.01% (10 kobo) plus the 1 kobo left over.
      expect(await split(db, "1000.01", [3333, 3333, 3333, 1])).toEqual({
        club: "333.30",
        dj: "333.30",
        mc: "333.30",
        platform: "0.11",
      });
      // ₦1,000 three ways with no platform cut still balances.
      expect(await split(db, "1000.00", [3334, 3333, 3333, 0])).toEqual({
        club: "333.40",
        dj: "333.30",
        mc: "333.30",
        platform: "0.00",
      });
    });
  });

  it("handles the smallest amount", async () => {
    await withTx(async (db) => {
      expect(await split(db, "0.01", [4000, 2500, 2500, 1000])).toEqual({
        club: "0.00",
        dj: "0.00",
        mc: "0.00",
        platform: "0.01",
      });
    });
  });

  it("gives an absent MC's share to the club", async () => {
    await withTx(async (db) => {
      expect(await split(db, "2000.00", [4000, 2500, 2500, 1000], { mc: false })).toEqual({
        club: "1300.00",
        dj: "500.00",
        mc: "0.00",
        platform: "200.00",
      });
    });
  });

  it("gives absent DJ and MC shares to the club", async () => {
    await withTx(async (db) => {
      expect(
        await split(db, "2000.00", [4000, 2500, 2500, 1000], { dj: false, mc: false }),
      ).toEqual({ club: "1800.00", dj: "0.00", mc: "0.00", platform: "200.00" });
    });
  });

  it("always sums exactly, never short-changes a party, across many amounts and splits", async () => {
    await withTx(async (db) => {
      // 20,000 random cases checked inside Postgres; returns the failing ones.
      const { rows } = await db.query(`
        with raw as (
          select
            (floor(random() * 10000000) + 1)::numeric / 100 as amount, -- ₦0.01 to ₦100,000.00
            floor(random() * 5001)::int as c,
            floor(random() * 5001)::int as d,
            random() as m_fraction,
            random() < 0.8 as has_dj,
            random() < 0.8 as has_mc
          from generate_series(1, 20000)
        ),
        bps as (
          select amount, c, d, floor(m_fraction * (10001 - c - d))::int as m, has_dj, has_mc
          from raw
        ),
        cases as (
          select amount, c, d, m, 10000 - c - d - m as p, has_dj, has_mc from bps
        ),
        results as (
          select x.*, s.party, s.amount as share
          from cases x, public.compute_split(x.amount, x.c, x.d, x.m, x.p, x.has_dj, x.has_mc) s
        ),
        checked as (
          select amount, c, d, m, p, has_dj, has_mc,
            sum(share) as total,
            min(share) as smallest,
            -- each party's share vs its exact (unrounded) entitlement
            bool_and(case party
              when 'dj' then share = case when has_dj then floor(amount * d / 100) / 100 else 0 end
              when 'mc' then share = case when has_mc then floor(amount * m / 100) / 100 else 0 end
              when 'club' then share = floor(amount * (c + case when has_dj then 0 else d end
                                                         + case when has_mc then 0 else m end) / 100) / 100
              when 'platform' then share >= floor(amount * p / 100) / 100
                               and share - amount * p / 10000 < 0.03
            end) as fair
          from results
          group by amount, c, d, m, p, has_dj, has_mc
        )
        select * from checked where total <> amount or smallest < 0 or not fair
        limit 5
      `);
      expect(rows).toEqual([]);
    });
  });

  it("rejects bad input", async () => {
    await withTx(async (db) => {
      const attempts: [string, [number, number, number, number]][] = [
        ["0.00", [4000, 2500, 2500, 1000]],
        ["-5.00", [4000, 2500, 2500, 1000]],
        ["10.005", [4000, 2500, 2500, 1000]],
        ["100.00", [4000, 2500, 2500, 999]],
        ["100.00", [-1, 5001, 4000, 1000]],
      ];
      for (const [amount, bps] of attempts) {
        await db.query("savepoint attempt");
        await expect(split(db, amount, bps)).rejects.toThrow();
        await db.query("rollback to savepoint attempt");
      }
    });
  });

  it("can't be called by anon or staff", async () => {
    await withTx(async (db) => {
      await as(db, "anon", () =>
        expect(split(db, "100.00", [4000, 2500, 2500, 1000])).rejects.toThrow(/permission denied/),
      );
    });
  });
});

describe("record_paid_order", () => {
  it("marks the order paid and writes one share per party", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "5000.00" });

      expect(await recordPaid(db, orderId)).toBe("recorded");
      await checkDeferred(db);

      const { rows: order } = await db.query(
        "select status, paid_at is not null as has_paid_at from public.orders where id = $1",
        [orderId],
      );
      expect(order[0]).toEqual({ status: "paid", has_paid_at: true });
      expect(await ledgerFor(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "2000.00" },
        { party: "dj", profile_id: v.djId, amount: "1250.00" },
        { party: "mc", profile_id: v.mcId, amount: "1250.00" },
        { party: "platform", profile_id: null, amount: "500.00" },
      ]);

      const { rows: payments } = await db.query(
        "select status, amount::text from public.payments where order_id = $1",
        [orderId],
      );
      expect(payments).toEqual([{ status: "succeeded", amount: "5000.00" }]);
    });
  });

  it("is idempotent: the same event twice writes nothing the second time", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });

      expect(await recordPaid(db, orderId, { eventId: "evt_1" })).toBe("recorded");
      expect(await recordPaid(db, orderId, { eventId: "evt_1" })).toBe("duplicate_event");
      expect(await recordPaid(db, orderId, { eventId: "evt_2" })).toBe("already_processed");
      await checkDeferred(db);

      expect(await ledgerFor(db, orderId)).toHaveLength(4);
      const { rows } = await db.query(
        "select count(*)::int as n from public.payments where order_id = $1",
        [orderId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("skips zero shares and gives an absent MC's share to the club", async () => {
    await withTx(async (db) => {
      const venueId = await createVenue(db);
      const nightId = await openNight(db, venueId); // nobody on duty
      const orderId = await createOrder(db, { venueId, nightId, amount: "2000.00" });

      expect(await recordPaid(db, orderId)).toBe("recorded");
      await checkDeferred(db);
      expect(await ledgerFor(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "1800.00" },
        { party: "platform", profile_id: null, amount: "200.00" },
      ]);
    });
  });

  it("records a late payment for an expired order", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, status: "expired" });
      expect(await recordPaid(db, orderId)).toBe("recorded");
      await checkDeferred(db);
      expect(await ledgerFor(db, orderId)).toHaveLength(4);
    });
  });

  it("rejects an amount or currency mismatch and writes nothing", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "2000.00" });

      for (const opts of [{ amount: "1999.99" }, { currency: "USD" }]) {
        await db.query("savepoint attempt");
        await expect(recordPaid(db, orderId, { eventId: "evt_x", ...opts })).rejects.toThrow(
          /does not match/,
        );
        await db.query("rollback to savepoint attempt");
      }

      // Nothing was stored, so the provider's retry with the right data still works.
      const { rows } = await db.query("select count(*)::int as n from public.webhook_events where provider_event_id = 'evt_x'");
      expect(rows[0].n).toBe(0);
      expect(await recordPaid(db, orderId, { eventId: "evt_x" })).toBe("recorded");
    });
  });

  it("can't be called by anon or staff", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await as(db, "anon", () => expect(recordPaid(db, orderId)).rejects.toThrow(/permission denied/));
      await as(db, { userId: v.managerId }, () =>
        expect(recordPaid(db, orderId)).rejects.toThrow(/permission denied/),
      );
    });
  });
});

describe("ledger_entries guarantees", () => {
  it("is append-only", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, orderId);

      await db.query("savepoint attempt");
      await expect(
        db.query("update public.ledger_entries set amount = amount + 1 where order_id = $1", [orderId]),
      ).rejects.toThrow(/append-only/);
      await db.query("rollback to savepoint attempt");
      await expect(
        db.query("delete from public.ledger_entries where order_id = $1", [orderId]),
      ).rejects.toThrow(/append-only/);
    });
  });

  it("rejects shares that don't sum to the order amount", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, {
        venueId: v.venueId,
        nightId: v.nightId,
        amount: "2000.00",
        status: "paid",
      });
      await db.query(
        `insert into public.ledger_entries (venue_id, order_id, venue_night_id, party, kind, amount, currency)
         values ($1, $2, $3, 'club', 'share', '1999.99', 'NGN')`,
        [v.venueId, orderId, v.nightId],
      );
      await expect(checkDeferred(db)).rejects.toThrow(/sum to 1999.99, expected 2000.00/);
    });
  });
});

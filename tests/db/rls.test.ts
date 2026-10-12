// Multi-club isolation and role permissions, enforced by the database.
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { addStaff, createOrder, createStaffedVenue, createUser, createVenue, openNight, recordPaid } from "./fixtures";

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(`select count(*)::int as n from (${sql}) q`, params);
  return rows[0].n;
}

const attendeeOrder = (venueId: string, nightId: string, overrides: Record<string, unknown> = {}) => {
  const order = {
    venue_id: venueId,
    venue_night_id: nightId,
    type: "spray",
    nickname: "Table 7",
    spray_target: "dj",
    amount: "2000.00",
    currency: "NGN",
    ...overrides,
  };
  const cols = Object.keys(order);
  return {
    sql: `insert into public.orders (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    params: Object.values(order),
  };
};

describe("attendees (anon)", () => {
  it("can read active venues, their pricing and open night, but nothing private", async () => {
    await withTx(async (db) => {
      const active = await createStaffedVenue(db);
      const pending = await createVenue(db, { status: "pending" });

      await as(db, "anon", async () => {
        expect(await count(db, "select 1 from public.venues where id = $1", [active.venueId])).toBe(1);
        expect(await count(db, "select 1 from public.venues where id = $1", [pending])).toBe(0);
        expect(await count(db, "select 1 from public.venue_pricing where venue_id = $1", [active.venueId])).toBe(4);
        expect(
          await count(db, "select id, opened_at from public.venue_nights where venue_id = $1", [active.venueId]),
        ).toBe(1);
      });
      for (const table of ["venue_splits", "orders", "ledger_entries", "payments", "profiles", "venue_staff", "webhook_events", "payout_accounts"]) {
        await as(db, "anon", () =>
          expect(db.query(`select 1 from public.${table}`)).rejects.toThrow(/permission denied/),
        );
      }
      // Night columns naming staff are not public.
      await as(db, "anon", () =>
        expect(db.query("select dj_profile_id from public.venue_nights")).rejects.toThrow(/permission denied/),
      );
    });
  });

  it("can create a valid pending order", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const { sql, params } = attendeeOrder(v.venueId, v.nightId);
      await as(db, "anon", () => db.query(sql, params));
    });
  });

  it("can't create orders that break venue rules", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const suspended = await createVenue(db, { status: "suspended" });
      const suspendedNight = await openNight(db, suspended);
      const closedVenue = await createVenue(db);
      const closedNight = await openNight(db, closedVenue);
      await db.query("update public.venue_nights set closed_at = now() where id = $1", [closedNight]);
      const other = await createStaffedVenue(db);

      const bad = [
        attendeeOrder(v.venueId, v.nightId, { amount: "999.99" }), // below minimum
        attendeeOrder(v.venueId, v.nightId, { currency: "USD" }),
        attendeeOrder(suspended, suspendedNight),
        attendeeOrder(closedVenue, closedNight),
        attendeeOrder(v.venueId, other.nightId), // another venue's night
      ];
      for (const { sql, params } of bad) {
        await as(db, "anon", () => expect(db.query(sql, params)).rejects.toThrow());
      }

      await db.query("update public.venue_pricing set enabled = false where venue_id = $1 and order_type = 'spray'", [v.venueId]);
      const paused = attendeeOrder(v.venueId, v.nightId);
      await as(db, "anon", () => expect(db.query(paused.sql, paused.params)).rejects.toThrow(/row-level security/));
    });
  });

  it("can't create an order that is already paid", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      for (const overrides of [{ status: "paid" }, { paid_at: new Date() }]) {
        const { sql, params } = attendeeOrder(v.venueId, v.nightId, overrides);
        await as(db, "anon", () => expect(db.query(sql, params)).rejects.toThrow(/permission denied/));
      }
    });
  });
});

describe("multi-club isolation", () => {
  it("staff only see their own venue's orders, nights and team", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      await createOrder(db, { venueId: a.venueId, nightId: a.nightId });
      await createOrder(db, { venueId: b.venueId, nightId: b.nightId });

      for (const userId of [a.managerId, a.djId, a.mcId]) {
        await as(db, { userId }, async () => {
          expect(await count(db, "select 1 from public.orders where venue_id = $1", [a.venueId])).toBe(1);
          expect(await count(db, "select 1 from public.orders where venue_id = $1", [b.venueId])).toBe(0);
          expect(await count(db, "select 1 from public.venue_staff where venue_id = $1", [b.venueId])).toBe(0);
          expect(await count(db, "select 1 from public.venue_splits where venue_id = $1", [b.venueId])).toBe(0);
          expect(await count(db, "select 1 from public.profiles where id = $1", [b.managerId])).toBe(0);
        });
      }
    });
  });

  it("managers can't change another venue", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      await as(db, { userId: a.managerId }, async () => {
        const res = await db.query("update public.venues set name = 'Hijacked' where id = $1", [b.venueId]);
        expect(res.rowCount).toBe(0);
        const pricing = await db.query(
          "update public.venue_pricing set min_amount = 1 where venue_id = $1",
          [b.venueId],
        );
        expect(pricing.rowCount).toBe(0);
      });
      await as(db, { userId: a.managerId }, () =>
        expect(
          db.query(
            "insert into public.venue_nights (venue_id, night_date) values ($1, current_date + 1)",
            [b.venueId],
          ),
        ).rejects.toThrow(/row-level security/),
      );
    });
  });

  it("can't put another venue's DJ on duty", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      await as(db, { userId: a.managerId }, () =>
        expect(
          db.query("update public.venue_nights set dj_profile_id = $1 where id = $2", [b.djId, a.nightId]),
        ).rejects.toThrow(/not an active DJ/),
      );
    });
  });
});

describe("money visibility", () => {
  it("DJs and MCs see only their own ledger entries; managers see the venue's", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, orderId);

      const visible = (userId: string) =>
        as(db, { userId }, async () => {
          const { rows } = await db.query<{ party: string }>(
            "select party from public.ledger_entries where order_id = $1 order by party",
            [orderId],
          );
          return rows.map((r) => r.party);
        });

      expect(await visible(v.djId)).toEqual(["dj"]);
      expect(await visible(v.mcId)).toEqual(["mc"]);
      expect(await visible(v.managerId)).toEqual(["club", "dj", "mc", "platform"]);
      expect(await visible(await createUser(db))).toEqual([]);
      expect(await visible(await createUser(db, { isAdmin: true }))).toEqual(["club", "dj", "mc", "platform"]);
    });
  });

  it("staff can't write money tables", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, status: "paid" });
      await as(db, { userId: v.managerId }, () =>
        expect(
          db.query(
            `insert into public.ledger_entries (venue_id, order_id, venue_night_id, party, kind, amount, currency)
             values ($1, $2, $3, 'club', 'share', '2000.00', 'NGN')`,
            [v.venueId, orderId, v.nightId],
          ),
        ).rejects.toThrow(/permission denied/),
      );
      await as(db, { userId: v.managerId }, () =>
        expect(
          db.query("update public.venue_splits set club_bps = 9000, platform_bps = 0 where venue_id = $1", [v.venueId]),
        ).rejects.toThrow(/permission denied/),
      );
    });
  });

  it("users can't make themselves admin", async () => {
    await withTx(async (db) => {
      const userId = await createUser(db);
      await as(db, { userId }, () =>
        expect(db.query("update public.profiles set is_admin = true where id = $1", [userId])).rejects.toThrow(
          /permission denied/,
        ),
      );
    });
  });
});

describe("order decisions", () => {
  async function paidOrder(db: Db, v: { venueId: string; nightId: string }, type: "song_request" | "screen_shoutout" | "mc_shoutout") {
    return createOrder(db, { venueId: v.venueId, nightId: v.nightId, type, status: "paid" });
  }

  it("the DJ decides song requests and is recorded as the decider", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await paidOrder(db, v, "song_request");
      const decided = await as(db, { userId: v.djId }, async () => {
        await db.query("update public.orders set status = 'approved' where id = $1", [orderId]);
        const { rows } = await db.query("select status, decided_by from public.orders where id = $1", [orderId]);
        return rows[0];
      });
      expect(decided).toEqual({ status: "approved", decided_by: v.djId });
    });
  });

  it("roles can only decide their own order types", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const screen = await paidOrder(db, v, "screen_shoutout");
      const song = await paidOrder(db, v, "song_request");
      const update = (id: string) => db.query("update public.orders set status = 'approved' where id = $1", [id]);

      await as(db, { userId: v.djId }, async () => expect((await update(screen)).rowCount).toBe(0));
      await as(db, { userId: v.mcId }, async () => expect((await update(song)).rowCount).toBe(0));
      await as(db, { userId: v.managerId }, async () => expect((await update(screen)).rowCount).toBe(1));
    });
  });

  it("staff can't mark orders paid or refunded", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const pending = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request" });
      const paid = await paidOrder(db, v, "song_request");

      await as(db, { userId: v.djId }, () =>
        expect(db.query("update public.orders set status = 'paid' where id = $1", [pending])).rejects.toThrow(
          /not allowed/,
        ),
      );
      await as(db, { userId: v.managerId }, () =>
        expect(db.query("update public.orders set status = 'refunded' where id = $1", [paid])).rejects.toThrow(
          /not allowed/,
        ),
      );
      await as(db, { userId: v.managerId }, () =>
        expect(db.query("update public.orders set amount = 1 where id = $1", [paid])).rejects.toThrow(
          /permission denied/,
        ),
      );
    });
  });

  it("revoked staff lose access", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const song = await paidOrder(db, v, "song_request");
      await db.query("update public.venue_staff set status = 'revoked' where profile_id = $1", [v.djId]);
      await as(db, { userId: v.djId }, async () => {
        expect(await count(db, "select 1 from public.orders where venue_id = $1", [v.venueId])).toBe(0);
        const res = await db.query("update public.orders set status = 'approved' where id = $1", [song]);
        expect(res.rowCount).toBe(0);
      });
    });
  });

  it("a new DJ can be added and put on duty", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const newDj = await createUser(db);
      await addStaff(db, v.venueId, newDj, "dj");
      await as(db, { userId: v.managerId }, async () => {
        const res = await db.query("update public.venue_nights set dj_profile_id = $1 where id = $2", [newDj, v.nightId]);
        expect(res.rowCount).toBe(1);
      });
    });
  });
});

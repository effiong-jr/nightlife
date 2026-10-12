// Realtime broadcasts, channel authorisation and the public screen snapshot.
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { createOrder, createStaffedVenue, createUser, recordPaid } from "./fixtures";

async function messages(db: Db, topic: string) {
  const { rows } = await db.query<{ event: string; private: boolean; payload: Record<string, unknown> }>(
    "select event, private, payload from realtime.messages where topic = $1 order by inserted_at, id",
    [topic],
  );
  return rows;
}

async function canJoin(db: Db, userId: string | "anon", topic: string): Promise<boolean> {
  return as(db, userId === "anon" ? "anon" : { userId }, async () => {
    const { rows } = await db.query<{ ok: boolean }>("select public.can_join_venue_topic($1) as ok", [topic]);
    return rows[0].ok;
  });
}

describe("order broadcasts", () => {
  it("tells staff about paid orders on the private venue channel, not about pending ones", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request" });
      expect(await messages(db, `venue:${v.venueId}`)).toEqual([]);

      await recordPaid(db, orderId);
      expect(await messages(db, `venue:${v.venueId}`)).toEqual([
        { event: "order_changed", private: true, payload: { id: orderId, type: "song_request", status: "paid" } },
      ]);
    });
  });

  it("puts paid sprays on the public screen channel with only display fields", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", amount: "50000.00" });
      await recordPaid(db, orderId);

      expect(await messages(db, `screen:${v.venueId}`)).toEqual([
        {
          event: "spray",
          private: false,
          payload: { id: orderId, name: "Table 7", table: null, amount: "50000.00", target: "dj", celebrant: null },
        },
      ]);
    });
  });

  it("hides the nickname of attendees who opted out of the leaderboard", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray" });
      await db.query("update public.orders set show_on_leaderboard = false where id = $1", [orderId]);
      await recordPaid(db, orderId);
      const [spray] = await messages(db, `screen:${v.venueId}`);
      expect(spray.payload.name).toBe("A big spender");
    });
  });

  it("shows screen shoutouts only once a manager approves them", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "screen_shoutout" });
      await recordPaid(db, orderId);
      expect(await messages(db, `screen:${v.venueId}`)).toEqual([]);

      await as(db, { userId: v.managerId }, async () => {
        await db.query("update public.orders set status = 'approved' where id = $1", [orderId]);
        await db.query("reset role"); // read realtime.messages back as the superuser
        const screen = await messages(db, `screen:${v.venueId}`);
        expect(screen).toEqual([
          {
            event: "shoutout",
            private: false,
            payload: { id: orderId, name: "Table 7", message: "Happy birthday Tolu!" },
          },
        ]);
      });
    });
  });

  it("never breaks payment recording if broadcasting fails", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray" });
      // Make the broadcast blow up mid-way (rolled back with the test transaction).
      await db.query(
        "create or replace function public.screen_display_name(p_order public.orders) returns text language plpgsql as $$ begin raise exception 'broadcast broke'; end $$",
      );
      expect(await recordPaid(db, orderId)).toBe("recorded");
      const { rows } = await db.query("select status from public.orders where id = $1", [orderId]);
      expect(rows[0].status).toBe("paid");
      expect(await messages(db, `screen:${v.venueId}`)).toEqual([]);
    });
  });
});

describe("channel authorisation", () => {
  it("only lets active staff join their venue's private channel", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      const outsider = await createUser(db);

      expect(await canJoin(db, a.managerId, `venue:${a.venueId}`)).toBe(true);
      expect(await canJoin(db, a.djId, `venue:${a.venueId}`)).toBe(true);
      expect(await canJoin(db, a.djId, `venue:${b.venueId}`)).toBe(false);
      expect(await canJoin(db, outsider, `venue:${a.venueId}`)).toBe(false);
      expect(await canJoin(db, "anon", `venue:${a.venueId}`)).toBe(false);
      expect(await canJoin(db, a.djId, "venue:not-a-uuid")).toBe(false);
      expect(await canJoin(db, a.djId, `screen:${a.venueId}`)).toBe(false);

      await db.query("update public.venue_staff set status = 'revoked' where profile_id = $1", [a.djId]);
      expect(await canJoin(db, a.djId, `venue:${a.venueId}`)).toBe(false);
    });
  });
});

describe("screen_snapshot", () => {
  it("gives anon tonight's leaderboard (nicknames only, opt-outs excluded) and approved shoutouts", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const spray = async (nickname: string, amount: string, showOnLeaderboard = true) => {
        const id = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", amount });
        await db.query("update public.orders set nickname = $2, show_on_leaderboard = $3 where id = $1", [
          id,
          nickname,
          showOnLeaderboard,
        ]);
        await recordPaid(db, id);
      };
      await spray("Tunde", "5000.00");
      await spray("Amaka", "20000.00");
      await spray("Tunde", "20000.00"); // Tunde's total: 25k
      await spray("Hidden", "90000.00", false);
      const unpaid = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", amount: "99000.00" });
      expect(unpaid).toBeTruthy();

      const shoutout = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "screen_shoutout" });
      await recordPaid(db, shoutout);
      const pendingApproval = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "screen_shoutout" });
      await recordPaid(db, pendingApproval);
      await db.query("update public.orders set status = 'approved', decided_at = now() where id = $1", [shoutout]);

      const snapshot = await as(db, "anon", async () => {
        const { rows } = await db.query("select public.screen_snapshot($1) as s", [v.venueId]);
        return rows[0].s;
      });
      expect(snapshot).toEqual({
        open: true,
        leaderboard: ["Tunde", "Amaka"],
        shoutouts: [{ id: shoutout, name: "Table 7", message: "Happy birthday Tolu!" }],
      });
    });
  });

  it("is empty for a venue that isn't open", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("update public.venue_nights set closed_at = now() where id = $1", [v.nightId]);
      const { rows } = await db.query("select public.screen_snapshot($1) as s", [v.venueId]);
      expect(rows[0].s).toEqual({ open: false, leaderboard: [], shoutouts: [] });
    });
  });
});

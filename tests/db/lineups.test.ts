// Lineups and attribution (CLAUDE.md "Lineups"): sets, changeovers, unassigned
// shares, targeted sprays and what settlement may pay.
import { describe, expect, it } from "vitest";
import { as, checkDeferred, type Db, withTx } from "./db";
import {
  addSet,
  addStaff,
  createOrder,
  createStaffedVenue,
  createUser,
  createVenue,
  openNight,
  recordPaid,
} from "./fixtures";

type Entry = { party: string; profile_id: string | null; amount: string; assigned_by: string | null };

async function ledger(db: Db, orderId: string): Promise<Entry[]> {
  const { rows } = await db.query<Entry>(
    `select party, profile_id, amount::text, assigned_by from public.ledger_entries
     where order_id = $1 and kind = 'share' order by party`,
    [orderId],
  );
  return rows;
}

async function settlement(db: Db, nightId: string) {
  const { rows } = await db.query<{ party: string; profile_id: string | null; amount: string }>(
    `select party, profile_id, amount::text from public.night_settlement_amounts($1) order by party, amount`,
    [nightId],
  );
  return rows;
}

async function unassignedTotal(db: Db, nightId: string): Promise<string> {
  const { rows } = await db.query("select public.night_unassigned_total($1)::text as total", [nightId]);
  return rows[0].total;
}

const setStatus = (db: Db, userId: string, orderId: string, status: string) =>
  as(db, { userId }, () => db.query("update public.orders set status = $2 where id = $1", [orderId, status]));

// Runs fn as a user without rolling back their writes (as() always rolls back).
async function asKeeping(db: Db, userId: string, fn: () => Promise<unknown>) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  await db.query("set local role authenticated");
  try {
    await fn();
  } finally {
    await db.query("reset role");
  }
}

describe("song request played after a changeover", () => {
  it("pays the DJ who played it, not the DJ on when it was paid", async () => {
    await withTx(async (db) => {
      // Song requests: club 30 / DJ 60 / MC 0 / platform 10. DJ A (v.djId) on since an hour ago.
      const v = await createStaffedVenue(db, { split: { club: 3000, dj: 6000, mc: 0, platform: 1000 } });
      const djB = await createUser(db);
      await addStaff(db, v.venueId, djB, "dj");

      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request", amount: "10000.00" });
      expect(await recordPaid(db, orderId)).toBe("recorded");
      await checkDeferred(db);

      // At payment: attributed to A's set, but the DJ share is unassigned.
      const { rows: atPayment } = await db.query(
        "select o.dj_set_id, s.profile_id as set_dj from public.orders o join public.venue_sets s on s.id = o.dj_set_id where o.id = $1",
        [orderId],
      );
      expect(atPayment[0].set_dj).toBe(v.djId);
      expect(await ledger(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "3000.00", assigned_by: null },
        { party: "dj", profile_id: null, amount: "6000.00", assigned_by: null },
        { party: "platform", profile_id: null, amount: "1000.00", assigned_by: null },
      ]);

      // A accepts it, then hands over to B before playing it.
      await asKeeping(db, v.djId, () =>
        db.query("update public.orders set status = 'approved' where id = $1", [orderId]),
      );
      await asKeeping(db, v.managerId, () => db.query("select public.start_set($1, 'dj', $2)", [v.venueId, djB]));

      // The accepted request is still in the (venue-wide) queue for B, who plays it.
      await asKeeping(db, djB, async () => {
        const { rows } = await db.query("select status from public.orders where id = $1", [orderId]);
        expect(rows[0].status).toBe("approved");
        await db.query("update public.orders set status = 'fulfilled' where id = $1", [orderId]);
      });

      const dj = (await ledger(db, orderId)).find((e) => e.party === "dj");
      expect(dj).toEqual({ party: "dj", profile_id: djB, amount: "6000.00", assigned_by: djB });
      expect(await settlement(db, v.nightId)).toEqual([
        { party: "club", profile_id: null, amount: "3000.00" },
        { party: "dj", profile_id: djB, amount: "6000.00" },
      ]);
    });
  });

  it("pays the MC who read an MC shoutout", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const mcB = await createUser(db);
      await addStaff(db, v.venueId, mcB, "mc");
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "mc_shoutout", amount: "4000.00" });
      await recordPaid(db, orderId);
      expect((await ledger(db, orderId)).find((e) => e.party === "mc")?.profile_id).toBeNull();

      await asKeeping(db, mcB, () => db.query("update public.orders set status = 'fulfilled' where id = $1", [orderId]));
      expect((await ledger(db, orderId)).find((e) => e.party === "mc")).toMatchObject({ profile_id: mcB, assigned_by: mcB });
    });
  });

  it("only a DJ can mark a song played, and only an MC can mark a shoutout read", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const song = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request" });
      const shoutout = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "mc_shoutout" });
      await recordPaid(db, song);
      await recordPaid(db, shoutout);

      await expect(setStatus(db, v.managerId, song, "fulfilled")).rejects.toThrow(/only a DJ/);
      await expect(setStatus(db, v.managerId, shoutout, "fulfilled")).rejects.toThrow(/only an MC/);
      // Managers can still reject either (it'll be refunded).
      await expect(setStatus(db, v.managerId, song, "rejected")).resolves.toBeTruthy();
    });
  });

  it("assigns a share once: it can't be reassigned or edited", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const other = await createUser(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request" });
      await recordPaid(db, orderId);
      await asKeeping(db, v.djId, () => db.query("update public.orders set status = 'fulfilled' where id = $1", [orderId]));

      for (const sql of [
        "update public.ledger_entries set profile_id = $2, assigned_at = now() where order_id = $1 and party = 'dj'",
        "update public.ledger_entries set amount = amount + 1 where order_id = $1 and party = 'dj' and $2::uuid is not null",
      ]) {
        await db.query("savepoint attempt");
        await expect(db.query(sql, [orderId, other])).rejects.toThrow(/append-only/);
        await db.query("rollback to savepoint attempt");
      }
    });
  });
});

describe("no overlapping sets", () => {
  it("rejects a second DJ set that overlaps, but allows back-to-back and a DJ alongside an MC", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // DJ and MC on open-ended sets from an hour ago
      const djB = await createUser(db);
      await addStaff(db, v.venueId, djB, "dj");
      const set = (startsAt: string, endsAt: string | null, profileId = djB, role: "dj" | "mc" = "dj") =>
        addSet(db, { venueId: v.venueId, nightId: v.nightId, profileId, role, startsAt, endsAt });
      const attempt = async (fn: () => Promise<unknown>) => {
        await db.query("savepoint attempt");
        try {
          await fn();
          await db.query("release savepoint attempt");
        } catch (err) {
          await db.query("rollback to savepoint attempt");
          throw err;
        }
      };

      // Overlaps DJ A's open-ended set.
      await expect(attempt(() => set(new Date(Date.now() + 3600e3).toISOString(), null))).rejects.toThrow(
        /venue_sets_no_overlap/,
      );

      // End A's set at a fixed time; B can start exactly then (back-to-back)...
      const handover = new Date(Date.now() + 2 * 3600e3).toISOString();
      await db.query("update public.venue_sets set ends_at = $2 where venue_id = $1 and role = 'dj'", [v.venueId, handover]);
      await expect(attempt(() => set(handover, null))).resolves.toBeUndefined();

      // ...but not a minute earlier.
      const djC = await createUser(db);
      await addStaff(db, v.venueId, djC, "dj");
      const early = new Date(Date.parse(handover) - 60e3).toISOString();
      await expect(attempt(() => set(early, handover, djC))).rejects.toThrow(/venue_sets_no_overlap/);

      // DJ and MC sets overlap freely: the MC has been on alongside DJ A all along.
      const { rows } = await db.query(
        `select count(*)::int as n from public.venue_sets d join public.venue_sets m
           on d.venue_id = m.venue_id and d.role = 'dj' and m.role = 'mc' and d.span && m.span
         where d.venue_id = $1`,
        [v.venueId],
      );
      expect(rows[0].n).toBeGreaterThan(0);

      // Another venue's DJ can be on at the same time.
      const other = await createVenue(db);
      const otherNight = await openNight(db, other);
      const otherDj = await createUser(db);
      await addStaff(db, other, otherDj, "dj");
      await expect(
        attempt(() => addSet(db, { venueId: other, nightId: otherNight, profileId: otherDj, role: "dj", startsAt: handover })),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects a set for someone who isn't active staff in that role", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("savepoint attempt");
      await expect(
        addSet(db, { venueId: v.venueId, nightId: v.nightId, profileId: v.mcId, role: "dj", startsAt: new Date(Date.now() + 9e6).toISOString() }),
      ).rejects.toThrow(/not an active dj/);
      await db.query("rollback to savepoint attempt");
    });
  });
});

describe("targeted sprays", () => {
  it("use the targeted split (default 50/40/10) and pay the target regardless of who's on", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // DJ and MC both on
      const orderId = await createOrder(db, {
        venueId: v.venueId,
        nightId: v.nightId,
        type: "spray",
        amount: "20000.00",
        target: { role: "mc", profileId: v.mcId },
      });
      await recordPaid(db, orderId);
      await checkDeferred(db);
      expect(await ledger(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "8000.00", assigned_by: null },
        { party: "mc", profile_id: v.mcId, amount: "10000.00", assigned_by: null },
        { party: "platform", profile_id: null, amount: "2000.00", assigned_by: null },
      ]);
    });
  });

  it("use the venue's own targeted split when set, even with nobody on", async () => {
    await withTx(async (db) => {
      const venueId = await createVenue(db);
      const dj = await createUser(db);
      await addStaff(db, venueId, dj, "dj");
      const nightId = await openNight(db, venueId); // no sets
      await db.query(
        "insert into public.venue_target_splits (venue_id, target_bps, club_bps, platform_bps) values ($1, 6000, 3000, 1000)",
        [venueId],
      );
      const orderId = await createOrder(db, { venueId, nightId, type: "spray", amount: "10000.00", target: { role: "dj", profileId: dj } });
      await recordPaid(db, orderId);
      expect(await ledger(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "3000.00", assigned_by: null },
        { party: "dj", profile_id: dj, amount: "6000.00", assigned_by: null },
        { party: "platform", profile_id: null, amount: "1000.00", assigned_by: null },
      ]);
    });
  });

  it("untargeted sprays use the normal spray split with whoever is on", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const orderId = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "spray", amount: "20000.00" });
      await recordPaid(db, orderId);
      expect(await ledger(db, orderId)).toEqual([
        { party: "club", profile_id: null, amount: "8000.00", assigned_by: null },
        { party: "dj", profile_id: v.djId, amount: "5000.00", assigned_by: null },
        { party: "mc", profile_id: v.mcId, amount: "5000.00", assigned_by: null },
        { party: "platform", profile_id: null, amount: "2000.00", assigned_by: null },
      ]);
    });
  });

  it("can only target an active DJ/MC of the venue, in their role", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const other = await createStaffedVenue(db);
      const attendeeSpray = (profileId: string, role: string) =>
        as(db, "anon", () =>
          db.query(
            `insert into public.orders (venue_id, venue_night_id, type, nickname, amount, currency, spray_target, target_profile_id)
             values ($1, $2, 'spray', 'Table 7', '2000.00', 'NGN', $3, $4)`,
            [v.venueId, v.nightId, role, profileId],
          ),
        );

      await expect(attendeeSpray(v.mcId, "mc")).resolves.toBeTruthy();
      await expect(attendeeSpray(other.djId, "dj")).rejects.toThrow(/not an active dj/); // another venue's DJ
      await expect(attendeeSpray(v.mcId, "dj")).rejects.toThrow(/not an active dj/); // wrong role
      await expect(attendeeSpray(v.managerId, "mc")).rejects.toThrow(/not an active mc/);
      await db.query("update public.venue_staff set status = 'removed' where profile_id = $1", [v.djId]);
      await expect(attendeeSpray(v.djId, "dj")).rejects.toThrow(/not an active dj/);
    });
  });
});

describe("settlement never pays unassigned shares", () => {
  it("excludes unplayed songs and unread shoutouts until they're fulfilled", async () => {
    await withTx(async (db) => {
      // Every type: club 40 / DJ 25 / MC 25 / platform 10, with DJ and MC on.
      const v = await createStaffedVenue(db);
      const song = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "song_request", amount: "10000.00" });
      const shoutout = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, type: "mc_shoutout", amount: "4000.00" });
      await recordPaid(db, song);
      await recordPaid(db, shoutout);

      // Waiting: the song's DJ share (2500) and the shoutout's MC share (1000).
      expect(await unassignedTotal(db, v.nightId)).toBe("3500.00");
      // Payable now: club 4000 + 1600; the shares earned by being on the set
      // (song MC 2500 to the MC on, shoutout DJ 1000 to the DJ on). Never a
      // row without a payee.
      const before = await settlement(db, v.nightId);
      expect(before).toEqual([
        { party: "club", profile_id: null, amount: "5600.00" },
        { party: "dj", profile_id: v.djId, amount: "1000.00" },
        { party: "mc", profile_id: v.mcId, amount: "2500.00" },
      ]);

      // Rejected: the song is refunded, so all its shares are reversed. Its
      // unassigned DJ share is never paid, and nor are the others.
      await asKeeping(db, v.djId, () => db.query("update public.orders set status = 'rejected' where id = $1", [song]));
      expect(await settlement(db, v.nightId)).toEqual([
        { party: "club", profile_id: null, amount: "1600.00" },
        { party: "dj", profile_id: v.djId, amount: "1000.00" },
      ]);
      expect(await unassignedTotal(db, v.nightId)).toBe("1000.00");

      // Read: the MC who read it is now owed that share.
      await asKeeping(db, v.mcId, () => db.query("update public.orders set status = 'fulfilled' where id = $1", [shoutout]));
      expect(await settlement(db, v.nightId)).toEqual([
        { party: "club", profile_id: null, amount: "1600.00" },
        { party: "dj", profile_id: v.djId, amount: "1000.00" },
        { party: "mc", profile_id: v.mcId, amount: "1000.00" },
      ]);
      expect(await unassignedTotal(db, v.nightId)).toBe("0.00");
    });
  });

  it("isn't callable by staff or attendees", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await as(db, { userId: v.managerId }, () =>
        expect(db.query("select * from public.night_settlement_amounts($1)", [v.nightId])).rejects.toThrow(
          /permission denied/,
        ),
      );
    });
  });
});

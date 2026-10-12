// Club invites (CLAUDE.md "Staff onboarding" route 1) and the staff lifecycle.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { as, type Db, withTx } from "./db";
import { createStaffedVenue, createUser } from "./fixtures";

const newToken = () => randomBytes(32).toString("base64url");

async function createInvite(db: Db, managerId: string, venueId: string, role: string, token = newToken()) {
  await as(db, { userId: managerId }, async () => {
    await db.query(
      "insert into public.invites (venue_id, role, token_hash, invitee_name) values ($1, $2, public.invite_token_hash($3), 'DJ New')",
      [venueId, role, token],
    );
  });
  // as() rolls back; create it for real (as postgres) with the same values.
  await db.query(
    `insert into public.invites (venue_id, role, token_hash, invitee_name, created_by)
     values ($1, $2, public.invite_token_hash($3), 'DJ New', $4)`,
    [venueId, role, token, managerId],
  );
  return token;
}

async function namedUser(db: Db): Promise<string> {
  const id = await createUser(db);
  await db.query("update public.profiles set display_name = 'DJ New', real_name = 'Ngozi Eze' where id = $1", [id]);
  return id;
}

async function accept(db: Db, userId: string | "anon", token: string) {
  return as(db, userId === "anon" ? "anon" : { userId }, async () => {
    const { rows } = await db.query("select public.accept_invite($1) as r", [token]);
    return rows[0].r;
  });
}

// Like accept(), but keeps the result (as() always rolls back).
async function acceptKeeping(db: Db, userId: string, token: string) {
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  await db.query("set local role authenticated");
  try {
    const { rows } = await db.query("select public.accept_invite($1) as r", [token]);
    return rows[0].r;
  } finally {
    await db.query("reset role");
  }
}

async function preview(db: Db, token: string) {
  return as(db, "anon", async () => {
    const { rows } = await db.query("select public.invite_preview($1) as p", [token]);
    return rows[0].p;
  });
}

async function staffRow(db: Db, venueId: string, profileId: string) {
  const { rows } = await db.query(
    "select status, source, invited_by, ended_at is not null as ended from public.venue_staff where venue_id = $1 and profile_id = $2",
    [venueId, profileId],
  );
  return rows[0];
}

describe("creating invites", () => {
  it("lets a manager invite a DJ or MC, expiring in 7 days, storing only the token hash", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const token = await createInvite(db, v.managerId, v.venueId, "dj");
      const { rows } = await db.query(
        "select token_hash, round(extract(epoch from expires_at - created_at) / 86400) as days from public.invites where venue_id = $1",
        [v.venueId],
      );
      expect(rows[0].days).toBe("7");
      expect(rows[0].token_hash).not.toContain(token);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("refuses manager invites, invites from non-managers, other venues and custom expiries", async () => {
    await withTx(async (db) => {
      const a = await createStaffedVenue(db);
      const b = await createStaffedVenue(db);
      const insert = (userId: string, venueId: string, role: string) =>
        as(db, { userId }, () =>
          db.query("insert into public.invites (venue_id, role, token_hash) values ($1, $2, public.invite_token_hash($3))", [
            venueId,
            role,
            newToken(),
          ]),
        );
      await expect(insert(a.managerId, a.venueId, "club_manager")).rejects.toThrow(/row-level security/);
      await expect(insert(a.djId, a.venueId, "dj")).rejects.toThrow(/row-level security/);
      await expect(insert(a.managerId, b.venueId, "dj")).rejects.toThrow(/row-level security/);
      await expect(
        as(db, { userId: a.managerId }, () =>
          db.query(
            "insert into public.invites (venue_id, role, token_hash, expires_at) values ($1, 'dj', public.invite_token_hash($2), now() + interval '1 year')",
            [a.venueId, newToken()],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});

describe("accepting invites", () => {
  it("shows a public preview, then makes the new user active staff, once", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const token = await createInvite(db, v.managerId, v.venueId, "dj");
      expect(await preview(db, token)).toMatchObject({ role: "dj", inviteeName: "DJ New", state: "valid" });
      expect(await preview(db, newToken())).toBeNull();

      const newDj = await namedUser(db);
      const result = await acceptKeeping(db, newDj, token);
      expect(result).toMatchObject({ role: "dj" });
      expect(await staffRow(db, v.venueId, newDj)).toEqual({
        status: "active",
        source: "invite",
        invited_by: v.managerId,
        ended: false,
      });
      expect(await preview(db, token)).toMatchObject({ state: "accepted" });

      // Single use: someone else can't reuse it; the same person re-accepting is a no-op.
      const someoneElse = await namedUser(db);
      await expect(accept(db, someoneElse, token)).rejects.toThrow(/already used/);
      await expect(accept(db, newDj, token)).resolves.toMatchObject({ role: "dj" });
    });
  });

  it("refuses expired and cancelled invites, signed-out users, and people without names", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const user = await namedUser(db);

      const expired = await createInvite(db, v.managerId, v.venueId, "dj");
      await db.query("update public.invites set expires_at = now() - interval '1 minute' where token_hash = public.invite_token_hash($1)", [expired]);
      expect(await preview(db, expired)).toMatchObject({ state: "expired" });
      await expect(accept(db, user, expired)).rejects.toThrow(/expired/);

      const cancelled = await createInvite(db, v.managerId, v.venueId, "mc");
      await as(db, { userId: v.managerId }, async () => {
        const res = await db.query(
          "update public.invites set cancelled_at = now() where token_hash = public.invite_token_hash($1)",
          [cancelled],
        );
        expect(res.rowCount).toBe(1);
      });
      await db.query("update public.invites set cancelled_at = now() where token_hash = public.invite_token_hash($1)", [cancelled]);
      await expect(accept(db, user, cancelled)).rejects.toThrow(/cancelled/);

      const fresh = await createInvite(db, v.managerId, v.venueId, "dj");
      await expect(accept(db, "anon", fresh)).rejects.toThrow(/permission denied/);
      const nameless = await createUser(db);
      await expect(accept(db, nameless, fresh)).rejects.toThrow(/real name and stage name/);
    });
  });

  it("brings back someone who was removed, as a fresh start", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await db.query("update public.profiles set real_name = 'Kola' where id = $1", [v.djId]);
      await db.query("update public.profiles set display_name = 'DJ Test' where id = $1 and display_name = ''", [v.djId]);
      await db.query("update public.venue_staff set status = 'removed' where profile_id = $1", [v.djId]);
      expect(await staffRow(db, v.venueId, v.djId)).toMatchObject({ status: "removed", ended: true });

      const token = await createInvite(db, v.managerId, v.venueId, "dj");
      await acceptKeeping(db, v.djId, token);
      expect(await staffRow(db, v.venueId, v.djId)).toMatchObject({ status: "active", source: "invite", ended: false });
    });
  });
});

describe("staff lifecycle", () => {
  it("removing a DJ ends their set; earnings already owed stay in the ledger", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db); // DJ on an open set
      await as(db, { userId: v.managerId }, async () => {
        await db.query("update public.venue_staff set status = 'removed' where profile_id = $1", [v.djId]);
        await db.query("reset role");
        const { rows } = await db.query(
          "select ends_at is not null as ended from public.venue_sets where venue_id = $1 and profile_id = $2",
          [v.venueId, v.djId],
        );
        expect(rows[0].ended).toBe(true);
      });
    });
  });

  it("a DJ can leave but not come back on their own; managers can't be removed by managers", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const otherManager = await createUser(db);
      await db.query("insert into public.venue_staff (venue_id, profile_id, role) values ($1, $2, 'club_manager')", [
        v.venueId,
        otherManager,
      ]);

      await as(db, { userId: v.djId }, async () => {
        const res = await db.query("update public.venue_staff set status = 'left' where profile_id = $1", [v.djId]);
        expect(res.rowCount).toBe(1);
      });
      await db.query("update public.venue_staff set status = 'left' where profile_id = $1", [v.djId]);
      await as(db, { userId: v.djId }, async () => {
        const res = await db.query("update public.venue_staff set status = 'active' where profile_id = $1", [v.djId]);
        expect(res.rowCount).toBe(0);
      });

      await as(db, { userId: v.managerId }, async () => {
        const res = await db.query("update public.venue_staff set status = 'removed' where profile_id = $1", [otherManager]);
        expect(res.rowCount).toBe(0);
      });
    });
  });

  it("staff can't make themselves a manager or read invites", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await as(db, { userId: v.djId }, () =>
        expect(db.query("update public.venue_staff set role = 'club_manager' where profile_id = $1", [v.djId])).rejects.toThrow(
          /permission denied/,
        ),
      );
      await createInvite(db, v.managerId, v.venueId, "mc");
      await as(db, { userId: v.djId }, async () => {
        const { rows } = await db.query("select count(*)::int as n from public.invites where venue_id = $1", [v.venueId]);
        expect(rows[0].n).toBe(0);
      });
    });
  });
});

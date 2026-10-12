// Admin: venue creation, managers by phone, retries and the review queue.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { addManagerByPhone, createVenue, getReviewQueue } from "@/lib/server/admin";
import type { Database } from "@/lib/supabase/database.types";
import { as, withTx } from "./db";
import { createOrder, createStaffedVenue, recordPaid } from "./fixtures";

describe("admin database functions", () => {
  it("creates a pending venue with default prices, splits and targeted split", async () => {
    await withTx(async (db) => {
      const slug = `club-${randomUUID().slice(0, 8)}`;
      const { rows } = await db.query("select public.create_venue('New Club', $1, 'Lekki') as id", [slug]);
      const id = rows[0].id;
      const counts = await db.query(
        `select v.status,
                (select count(*)::int from public.venue_pricing where venue_id = v.id) as pricing,
                (select count(*)::int from public.venue_splits where venue_id = v.id) as splits,
                (select target_bps from public.venue_target_splits where venue_id = v.id) as target
         from public.venues v where v.id = $1`,
        [id],
      );
      expect(counts.rows[0]).toEqual({ status: "pending", pricing: 4, splits: 4, target: 5000 });
      // Pending venues take no orders and aren't public.
      await as(db, "anon", async () => {
        const { rows: visible } = await db.query("select 1 from public.venues where id = $1", [id]);
        expect(visible).toHaveLength(0);
      });
    });
  });

  it("retries a failed refund as a new attempt, and a failed payout from the hop it failed at", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      const order = await createOrder(db, { venueId: v.venueId, nightId: v.nightId });
      await recordPaid(db, order);
      await db.query("update public.orders set status = 'rejected' where id = $1", [order]);
      const { rows: refund } = await db.query("select id from public.refunds where order_id = $1", [order]);
      await db.query("select public.record_refund_status($1, 'failed', null, 'not refundable')", [refund[0].id]);

      await db.query("select public.retry_refund($1)", [order]);
      const { rows: refunds } = await db.query("select status, reason from public.refunds where order_id = $1 order by created_at", [order]);
      expect(refunds).toEqual([
        { status: "failed", reason: "rejected_by_staff" },
        { status: "pending", reason: "admin" },
      ]);

      await db.query(
        `insert into public.payout_accounts (profile_id, provider, recipient_id, status) values ($1, 'bachs', 'acct_x', 'active')`,
        [v.djId],
      );
      const paid = await createOrder(db, { venueId: v.venueId, nightId: v.nightId, amount: "10000.00" });
      await recordPaid(db, paid);
      await db.query("select public.close_night($1)", [v.nightId]);
      await db.query("select public.settle_night($1)", [v.nightId]);
      await db.query(
        "update public.payouts set status = 'failed', provider_transfer_id = 'tr_1', last_error = 'bank rejected' where venue_night_id = $1 and party = 'dj'",
        [v.nightId],
      );
      const { rows: payout } = await db.query("select id from public.payouts where venue_night_id = $1 and party = 'dj'", [v.nightId]);
      await db.query("select public.retry_payout($1)", [payout[0].id]);
      const { rows: after } = await db.query("select status, last_error, attempts from public.payouts where id = $1", [payout[0].id]);
      expect(after[0]).toEqual({ status: "transferred", last_error: null, attempts: 0 });
    });
  });

  it("can't be used by club staff", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      for (const sql of [
        "select public.create_venue('X', 'x-club', '')",
        "select public.find_user_by_phone('+2348000000002')",
        "select public.retry_payout(gen_random_uuid())",
      ]) {
        await as(db, { userId: v.managerId }, () => expect(db.query(sql)).rejects.toThrow(/permission denied/));
      }
    });
  });
});

describe("admin library (end to end)", () => {
  const admin = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });

  it("creates a venue and adds a brand-new manager by phone who can then sign in", async () => {
    const slug = `e2e-admin-${randomUUID().slice(0, 8)}`;
    const venue = await createVenue(admin, { name: "E2E Admin Club", slug, address: "Ikoyi" });
    expect(venue.ok).toBe(true);
    if (!venue.ok) return;
    expect(await createVenue(admin, { name: "Dup", slug })).toEqual({ ok: false, error: "That web address (slug) is taken." });
    expect(await createVenue(admin, { name: "Bad", slug: "Not A Slug!" })).toMatchObject({ ok: false });

    // A random 0809… number nobody has.
    const phone = `0809${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const added = await addManagerByPhone(admin, venue.venueId, { phone, realName: "Ngozi Club", stageName: "Ngozi (Manager)" });
    expect(added).toMatchObject({ ok: true, created: true });
    if (!added.ok) return;

    const { data: staff } = await admin
      .from("venue_staff")
      .select("role, status, source")
      .eq("venue_id", venue.venueId)
      .eq("profile_id", added.profileId)
      .single();
    expect(staff).toEqual({ role: "club_manager", status: "active", source: "admin" });

    // Same number again: reuses the account, doesn't overwrite their names.
    const again = await addManagerByPhone(admin, venue.venueId, { phone, realName: "Someone Else", stageName: "Other" });
    expect(again).toMatchObject({ ok: true, created: false, profileId: added.profileId });
    const { data: profile } = await admin.from("profiles").select("display_name, real_name").eq("id", added.profileId).single();
    expect(profile).toEqual({ display_name: "Ngozi (Manager)", real_name: "Ngozi Club" });

    expect(await addManagerByPhone(admin, venue.venueId, { phone: "12345", realName: "X Y", stageName: "XY" })).toMatchObject({
      ok: false,
    });
  });

  it("lists flagged payments until they're marked resolved", async () => {
    const eventId = `evt_${randomUUID()}`;
    await admin.rpc("record_webhook_failure", {
      p_provider: "bachs",
      p_event_id: eventId,
      p_event_type: "collection.succeeded",
      p_payload: {},
      p_error: "Underpaid: received 1500.00 NGN",
    });
    const flagged = (await getReviewQueue(admin)).flaggedEvents.find((e) => e.error.startsWith("Underpaid") && e.type === "collection.succeeded");
    expect(flagged).toBeTruthy();

    const { data: row } = await admin.from("webhook_events").select("id").eq("provider_event_id", eventId).single();
    await admin.from("webhook_events").update({ resolved_at: new Date().toISOString(), resolution_note: "Refunded by hand" }).eq("id", row!.id);
    expect((await getReviewQueue(admin)).flaggedEvents.some((e) => e.id === row!.id)).toBe(false);
  });
});

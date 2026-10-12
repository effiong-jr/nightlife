// End-to-end payment flow against local Supabase over its real API:
// attendee order -> checkout -> signed webhook through the route -> paid -> ledger.
//
// Bachs itself is stubbed at the HTTP boundary (no network). Unlike the other DB
// tests this commits data (the ledger is append-only, so it can't be cleaned
// up); each test uses its own venue, and `npm run db:reset` clears it all.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as webhookRoute } from "@/app/api/webhooks/bachs/route";
import { createBachsProvider, signPayload } from "@/lib/payments/bachs";
import { createOrderAndCheckout, OrderRejectedError } from "@/lib/server/orders";
import type { Database } from "@/lib/supabase/database.types";

const WEBHOOK_SECRET = "whsec_e2e_test";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

let admin: SupabaseClient<Database>;
let anon: SupabaseClient<Database>;

beforeAll(() => {
  admin = createClient<Database>(url, process.env.SUPABASE_SECRET_KEY!, noSession);
  anon = createClient<Database>(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noSession);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function must<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw error;
  if (data == null) throw new Error("Query returned no data");
  return data;
}

async function exec(query: PromiseLike<{ error: unknown }>): Promise<void> {
  const { error } = await query;
  if (error) throw error;
}

async function createUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${randomUUID()}@e2e.test`,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

async function setUpVenue() {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const venue = await must(admin.from("venues").insert({ slug, name: "E2E Lounge", status: "active" }).select("id").single());
  const types = ["spray", "screen_shoutout", "mc_shoutout", "song_request"] as const;
  await exec(admin.from("venue_pricing").insert(types.map((order_type) => ({ venue_id: venue.id, order_type, min_amount: 1000 }))));
  await exec(
    admin.from("venue_splits").insert(
      types.map((order_type) => ({ venue_id: venue.id, order_type, club_bps: 4000, dj_bps: 2500, mc_bps: 2500, platform_bps: 1000 })),
    ),
  );
  const djId = await createUser();
  const mcId = await createUser();
  await exec(
    admin.from("venue_staff").insert([
      { venue_id: venue.id, profile_id: djId, role: "dj" },
      { venue_id: venue.id, profile_id: mcId, role: "mc" },
    ]),
  );
  const night = await must(
    admin
      .from("venue_nights")
      .insert({ venue_id: venue.id, night_date: new Date().toISOString().slice(0, 10), opened_at: new Date().toISOString() })
      .select("id")
      .single(),
  );
  await exec(
    admin.from("venue_sets").insert([
      { venue_id: venue.id, venue_night_id: night.id, profile_id: djId, role: "dj" },
      { venue_id: venue.id, venue_night_id: night.id, profile_id: mcId, role: "mc" },
    ]),
  );
  return { slug, venueId: venue.id, djId, mcId };
}

// A provider whose HTTP calls hit a fake Bachs that issues checkouts.
function fakeBachs() {
  const checkouts: string[] = [];
  const fetchStub: typeof fetch = async () => {
    const checkoutId = `chk_${randomUUID().slice(0, 12)}`;
    checkouts.push(checkoutId);
    return Response.json(
      { checkout_id: checkoutId, checkout_url: `https://checkout.bachs.io/c/${checkoutId}`, status: "open", expires_at: "2026-12-31T00:00:00Z" },
      { status: 201 },
    );
  };
  return { provider: createBachsProvider({ secretKey: "sk_sandbox_e2e", fetch: fetchStub }), checkouts };
}

async function placeOrder(slug: string, amount = "5000.00") {
  const bachs = fakeBachs();
  const result = await createOrderAndCheckout(
    { venueSlug: slug, type: "spray", nickname: "Table 7", amount },
    { db: anon, admin, provider: bachs.provider, appUrl: "http://localhost:3000" },
  );
  return { ...result, checkoutId: bachs.checkouts[0] };
}

function webhookRequest(event: object, opts: { secret?: string; tamper?: boolean } = {}) {
  const body = JSON.stringify(event);
  const signature = signPayload(body, opts.secret ?? WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  return new Request("http://localhost:3000/api/webhooks/bachs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bachs-signature-v2": signature },
    body: opts.tamper ? body.replace("5000.00", "50.00") : body,
  });
}

function collectionSucceeded(orderId: string, checkoutId: string | null, amount = "5000.00", eventId = `evt_${randomUUID()}`) {
  return {
    id: eventId,
    type: "collection.succeeded",
    created_at: new Date().toISOString(),
    organization_id: "acct_e2e",
    data: {
      charge_id: `ch_${randomUUID()}`,
      checkout_id: checkoutId,
      reference: orderId,
      status: "SUCCEEDED",
      amount,
      currency: "NGN",
      metadata: { order_id: orderId },
    },
  };
}

async function deliver(event: object, opts?: { secret?: string; tamper?: boolean }) {
  vi.stubEnv("BACHS_WEBHOOK_SECRET", WEBHOOK_SECRET);
  const res = await webhookRoute(webhookRequest(event, opts));
  return { status: res.status, body: (await res.json()) as { result: string } };
}

async function orderState(orderId: string) {
  const order = await must(admin.from("orders").select("status, amount::text").eq("id", orderId).single());
  const ledger = await must(
    admin.from("ledger_entries").select("party, profile_id, amount::text").eq("order_id", orderId).order("party"),
  );
  const payments = await must(
    admin.from("payments").select("status, provider_checkout_id, provider_collection_id").eq("order_id", orderId),
  );
  return { order, ledger, payments };
}

describe("payment flow (end to end)", () => {
  it("order -> checkout -> webhook -> paid with ledger shares", async () => {
    const v = await setUpVenue();
    const { orderId, checkoutUrl, checkoutId } = await placeOrder(v.slug);
    expect(checkoutUrl).toBe(`https://checkout.bachs.io/c/${checkoutId}`);

    const before = await orderState(orderId);
    expect(before.order).toEqual({ status: "pending_payment", amount: "5000.00" });
    expect(before.payments).toEqual([{ status: "pending", provider_checkout_id: checkoutId, provider_collection_id: null }]);

    const event = collectionSucceeded(orderId, checkoutId);
    expect(await deliver(event)).toEqual({ status: 200, body: { received: true, result: "recorded" } });

    const after = await orderState(orderId);
    expect(after.order.status).toBe("paid");
    expect(after.payments).toEqual([
      { status: "succeeded", provider_checkout_id: checkoutId, provider_collection_id: event.data.charge_id },
    ]);
    expect(after.ledger).toEqual([
      { party: "club", profile_id: null, amount: "2000.00" },
      { party: "dj", profile_id: v.djId, amount: "1250.00" },
      { party: "mc", profile_id: v.mcId, amount: "1250.00" },
      { party: "platform", profile_id: null, amount: "500.00" },
    ]);

    // Bachs delivers at least once: a redelivery changes nothing.
    expect((await deliver(event)).body.result).toBe("duplicate_event");
    expect((await orderState(orderId)).ledger).toHaveLength(4);
  });

  it("rejects bad signatures without touching the order", async () => {
    const v = await setUpVenue();
    const { orderId, checkoutId } = await placeOrder(v.slug);

    expect((await deliver(collectionSucceeded(orderId, checkoutId), { tamper: true })).status).toBe(400);
    expect((await deliver(collectionSucceeded(orderId, checkoutId), { secret: "whsec_wrong" })).status).toBe(400);
    expect((await orderState(orderId)).order.status).toBe("pending_payment");
  });

  it("refuses all webhooks while no secret is configured, so they're retried later", async () => {
    vi.stubEnv("BACHS_WEBHOOK_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await webhookRoute(webhookRequest({ id: "evt_x", type: "checkout.completed", data: {} }));
    expect(res.status).toBe(503);
  });

  it("stores unfixable payments for review and acknowledges them", async () => {
    const v = await setUpVenue();
    const { orderId, checkoutId } = await placeOrder(v.slug);

    const mismatch = collectionSucceeded(orderId, checkoutId, "4999.99");
    expect((await deliver(mismatch)).body.result).toBe("needs_review");
    const unknown = collectionSucceeded(randomUUID(), null);
    expect((await deliver(unknown)).body.result).toBe("needs_review");

    const stored = await must(
      admin.from("webhook_events").select("provider_event_id, error, processed_at").in("provider_event_id", [mismatch.id, unknown.id]),
    );
    expect(stored).toHaveLength(2);
    for (const e of stored) {
      expect(e.processed_at).toBeNull();
      expect(e.error).toMatch(/does not match|not found/);
    }
    expect((await orderState(orderId)).order.status).toBe("pending_payment");
  });

  it("expires abandoned checkouts, and still records a payment that arrives late", async () => {
    const v = await setUpVenue();
    const { orderId, checkoutId } = await placeOrder(v.slug);

    const expired = { id: `evt_${randomUUID()}`, type: "checkout.expired", data: { checkout_id: checkoutId, reference: orderId } };
    expect((await deliver(expired)).body.result).toBe("expired");
    const afterExpiry = await orderState(orderId);
    expect(afterExpiry.order.status).toBe("expired");
    expect(afterExpiry.payments[0].status).toBe("failed");

    expect((await deliver(collectionSucceeded(orderId, checkoutId))).body.result).toBe("recorded");
    const afterPayment = await orderState(orderId);
    expect(afterPayment.order.status).toBe("paid");
    expect(afterPayment.ledger).toHaveLength(4);
  });

  it("enforces venue rules when placing orders", async () => {
    const v = await setUpVenue();
    await expect(placeOrder(v.slug, "999.99")).rejects.toMatchObject({ reason: "not_allowed" });
    await expect(placeOrder("no-such-venue")).rejects.toBeInstanceOf(OrderRejectedError);
    await expect(placeOrder("no-such-venue")).rejects.toMatchObject({ reason: "venue_not_found" });
  });
});

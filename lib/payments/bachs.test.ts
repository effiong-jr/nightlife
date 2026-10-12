import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBachsProvider, signPayload, verifySignature } from "./bachs";
import { PaymentProviderError, WebhookNotConfiguredError, WebhookSignatureError } from "./types";

const SECRET = "whsec_test_secret";
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;
const ORDER_ID = "6f1b0c4e-8a5d-4f8e-9b7a-2c3d4e5f6a7b";

function headers(entries: Record<string, string>) {
  return new Headers(entries);
}

function collectionEvent(data: Record<string, unknown>, type = "collection.succeeded") {
  return JSON.stringify({
    id: "evt_123",
    type,
    created_at: "2026-10-12T20:00:00Z",
    organization_id: "acct_1",
    data: {
      charge_id: "ch_1",
      checkout_id: "chk_1",
      reference: ORDER_ID,
      status: "SUCCEEDED",
      amount: "2000.00",
      currency: "NGN",
      metadata: { order_id: ORDER_ID },
      ...data,
    },
  });
}

function parse(body: string) {
  const provider = createBachsProvider({ secretKey: "sk_sandbox_x", webhookSecret: SECRET, now: () => NOW_MS });
  return provider.parseWebhook(body, headers({ "x-bachs-signature-v2": signPayload(body, SECRET, NOW_S) }));
}

describe("verifySignature", () => {
  const body = '{"id":"evt_1"}';

  it("accepts a valid V2 signature", () => {
    expect(() =>
      verifySignature(body, headers({ "x-bachs-signature-v2": signPayload(body, SECRET, NOW_S) }), SECRET, NOW_MS),
    ).not.toThrow();
  });

  it("accepts any matching v1 during secret rotation", () => {
    const good = signPayload(body, SECRET, NOW_S).split(",")[1];
    const header = `t=${NOW_S},v1=${"0".repeat(64)},${good}`;
    expect(() => verifySignature(body, headers({ "x-bachs-signature-v2": header }), SECRET, NOW_MS)).not.toThrow();
  });

  it("accepts the legacy header pair", () => {
    const sig = createHmac("sha256", SECRET).update(`${NOW_S}.${body}`).digest("hex");
    expect(() =>
      verifySignature(
        body,
        headers({ "x-bachs-signature": sig, "x-bachs-timestamp": String(NOW_S) }),
        SECRET,
        NOW_MS,
      ),
    ).not.toThrow();
  });

  it.each([
    ["a tampered body", '{"id":"evt_2"}', signPayload(body, SECRET, NOW_S)],
    ["the wrong secret", body, signPayload(body, "whsec_other", NOW_S)],
    ["a stale timestamp", body, signPayload(body, SECRET, NOW_S - 301)],
    ["a future timestamp", body, signPayload(body, SECRET, NOW_S + 301)],
    ["a truncated signature", body, signPayload(body, SECRET, NOW_S).slice(0, -2)],
    ["no v1", body, `t=${NOW_S}`],
    ["garbage", body, "nonsense"],
  ])("rejects %s", (_, signedBody, header) => {
    expect(() => verifySignature(signedBody, headers({ "x-bachs-signature-v2": header }), SECRET, NOW_MS)).toThrow(
      WebhookSignatureError,
    );
  });

  it("accepts a signature from any of several endpoint secrets", () => {
    const both = `whsec_account_events, ${SECRET}`;
    expect(() =>
      verifySignature(body, headers({ "x-bachs-signature-v2": signPayload(body, SECRET, NOW_S) }), both, NOW_MS),
    ).not.toThrow();
    expect(() =>
      verifySignature(body, headers({ "x-bachs-signature-v2": signPayload(body, "whsec_other", NOW_S) }), both, NOW_MS),
    ).toThrow(WebhookSignatureError);
  });

  it("accepts the header names without the X- prefix too", () => {
    expect(() =>
      verifySignature(body, headers({ "bachs-signature-v2": signPayload(body, SECRET, NOW_S) }), SECRET, NOW_MS),
    ).not.toThrow();
  });

  it("rejects a request with no signature", () => {
    expect(() => verifySignature(body, headers({}), SECRET, NOW_MS)).toThrow(WebhookSignatureError);
  });

  it("refuses everything when no webhook secret is configured", () => {
    const provider = createBachsProvider({ secretKey: "sk_sandbox_x", now: () => NOW_MS });
    expect(() =>
      provider.parseWebhook(body, headers({ "x-bachs-signature-v2": signPayload(body, SECRET, NOW_S) })),
    ).toThrow(WebhookNotConfiguredError);
  });
});

describe("parseWebhook", () => {
  it("normalises a successful collection", () => {
    expect(parse(collectionEvent({}))).toMatchObject({
      kind: "payment_succeeded",
      eventId: "evt_123",
      orderId: ORDER_ID,
      checkoutId: "chk_1",
      collectionId: "ch_1",
      amount: { amount: "2000.00", currency: "NGN" },
      overpaidBy: null,
    });
  });

  it("records an overpayment at the amount due", () => {
    expect(
      parse(collectionEvent({ status: "OVERPAID", amount: "2500.00", expected_amount: "2000.00", overpaid_amount: "500.00" })),
    ).toMatchObject({ kind: "payment_succeeded", amount: { amount: "2000.00" }, overpaidBy: "500.00" });
  });

  it("treats an accepted underpayment as underpaid", () => {
    expect(parse(collectionEvent({ status: "ACCEPTED", amount: "1500.00", expected_amount: "2000.00" }))).toMatchObject({
      kind: "payment_underpaid",
      received: { amount: "1500.00" },
    });
  });

  it("treats an accepted exact payment as succeeded", () => {
    expect(parse(collectionEvent({ status: "ACCEPTED", expected_amount: "2000.00" }))).toMatchObject({
      kind: "payment_succeeded",
      amount: { amount: "2000.00" },
    });
  });

  it("excludes a processing fee the customer paid on top", () => {
    expect(
      parse(
        collectionEvent({
          amount: "2030.00",
          fee_bearer: "customer",
          processing_fee: "30.00",
          processing_fee_currency: "NGN",
        }),
      ),
    ).toMatchObject({ kind: "payment_succeeded", amount: { amount: "2000.00", currency: "NGN" } });
  });

  it("keeps the charged amount when the merchant bore the fee or the fee is unknown", () => {
    const merchant = { amount: "2000.00", fee_bearer: "merchant", processing_fee: "30.00", processing_fee_currency: "NGN" };
    expect(parse(collectionEvent(merchant))).toMatchObject({ amount: { amount: "2000.00" } });
    // Unknown fee: the order won't match, so it lands in review instead of being misrecorded.
    const unknownFee = { amount: "2030.00", fee_bearer: "customer", processing_fee: null };
    expect(parse(collectionEvent(unknownFee))).toMatchObject({ amount: { amount: "2030.00" } });
  });

  it("applies the customer fee to overpayments too", () => {
    expect(
      parse(
        collectionEvent({
          status: "OVERPAID",
          amount: "2530.00",
          expected_amount: "2030.00",
          overpaid_amount: "500.00",
          fee_bearer: "customer",
          processing_fee: "30.00",
        }),
      ),
    ).toMatchObject({ kind: "payment_succeeded", amount: { amount: "2000.00" }, overpaidBy: "500.00" });
  });

  it("falls back to the event ID when charge_id is null", () => {
    expect(parse(collectionEvent({ charge_id: null }))).toMatchObject({ collectionId: "event:evt_123" });
  });

  it("finds the order from reference when metadata is missing, and ignores non-UUIDs", () => {
    expect(parse(collectionEvent({ metadata: null }))).toMatchObject({ orderId: ORDER_ID });
    expect(parse(collectionEvent({ metadata: { order_id: "ORD-1" }, reference: "ORD-1" }))).toMatchObject({
      orderId: null,
    });
  });

  it("normalises underpaid and expired events, and ignores the rest", () => {
    expect(parse(collectionEvent({ amount: "100.00" }, "collection.underpaid"))).toMatchObject({
      kind: "payment_underpaid",
    });
    const expired = JSON.stringify({
      id: "evt_9",
      type: "checkout.expired",
      data: { checkout_id: "chk_1", reference: ORDER_ID },
    });
    expect(parse(expired)).toMatchObject({ kind: "checkout_expired", orderId: ORDER_ID, checkoutId: "chk_1" });
    expect(parse(JSON.stringify({ id: "evt_8", type: "checkout.completed", data: {} }))).toMatchObject({
      kind: "ignored",
    });
  });

  it("rejects amounts that aren't 2-decimal strings", () => {
    expect(() => parse(collectionEvent({ amount: 2000 }))).toThrow(WebhookSignatureError);
  });
});

describe("createCheckout", () => {
  const input = {
    orderId: ORDER_ID,
    amount: { amount: "2000.00", currency: "NGN" },
    successUrl: "http://localhost:3000/v/test/orders/1",
    cancelUrl: "http://localhost:3000/v/test",
    expiresInMinutes: 30,
    idempotencyKey: `checkout_order_${ORDER_ID}`,
    metadata: { venue_id: "v1" },
  };
  const okResponse = () =>
    Response.json(
      {
        checkout_id: "chk_abc",
        checkout_url: "https://checkout.bachs.io/c/abc",
        status: "open",
        expires_at: "2026-10-12T21:00:00Z",
      },
      { status: 201 },
    );

  it("sends the order as a priced sandbox checkout with an idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });

    await expect(provider.createCheckout(input)).resolves.toEqual({
      checkoutId: "chk_abc",
      checkoutUrl: "https://checkout.bachs.io/c/abc",
      expiresAt: "2026-10-12T21:00:00Z",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/checkout-sessions");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer sk_sandbox_key",
      "Idempotency-Key": `checkout_order_${ORDER_ID}`,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      pricing: { amount: "2000.00", currency: "NGN" },
      billing_currency: "NGN",
      customer_bears_fee: true,
      reference: ORDER_ID,
      metadata: { venue_id: "v1", order_id: ORDER_ID },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_in_minutes: 30,
    });
  });

  it("retries once with the same key while the first attempt is in progress", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "IDEMPOTENCY_IN_PROGRESS" } }, { status: 409 }))
      .mockResolvedValueOnce(okResponse());
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    const result = provider.createCheckout(input);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ checkoutId: "chk_abc" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ "Idempotency-Key": input.idempotencyKey });
    vi.useRealTimers();
  });

  it("surfaces Bachs validation errors with their detail", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        { detail: "success_url must be a publicly accessible URL (localhost is not allowed)", error_code: "VALIDATION_ERROR" },
        { status: 400 },
      ),
    );
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(provider.createCheckout(input)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("localhost is not allowed"),
    });
  });

  it("surfaces API errors with status and code", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: { code: "IDEMPOTENCY_CONFLICT" } }, { status: 409 }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(provider.createCheckout(input)).rejects.toMatchObject({
      name: "PaymentProviderError",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(provider.createCheckout(input)).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe("refunds", () => {
  it("requests a full refund with idempotency, absorbing any refund fee", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ refund_id: "rfnd_123", status: "processing" }, { status: 201 }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });

    await expect(
      provider.createRefund({
        chargeId: "ch_1",
        reference: ORDER_ID,
        idempotencyKey: `refund_${ORDER_ID}`,
        reason: "Song request not played in time",
      }),
    ).resolves.toEqual({ providerRefundId: "rfnd_123", status: "processing" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/refunds");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": `refund_${ORDER_ID}` });
    expect(JSON.parse(init?.body as string)).toEqual({
      charge_id: "ch_1",
      reference: ORDER_ID,
      reason: "Song request not played in time",
      idempotency_key: `refund_${ORDER_ID}`,
      fee_bearer: "org",
    });
  });

  it("normalises refund webhooks", () => {
    const event = (type: string, status: string) =>
      JSON.stringify({ id: "evt_r", type, data: { refund_id: "rfnd_123", reference: ORDER_ID, status } });
    expect(parse(event("refund.created", "processing"))).toMatchObject({
      kind: "refund_updated",
      refundId: ORDER_ID,
      providerRefundId: "rfnd_123",
      status: "processing",
    });
    expect(parse(event("refund.paid", "success"))).toMatchObject({ status: "succeeded" });
    expect(parse(event("refund.failed", "failed"))).toMatchObject({ status: "failed" });
  });
});

describe("payee accounts (Connect)", () => {
  // Shape returned by the real sandbox (2026-10-12): capabilities active at
  // once, but name and bank account still due.
  const sandboxAccount = {
    id: "acct_EH2MXTOkrNaUvezJ",
    capabilities: {
      payouts: { status: "active", requested: true, status_details: null },
      transfers: { status: "active", requested: true, status_details: null },
      conversions: { status: "active", requested: true, status_details: null },
    },
    requirements: { currently_due: ["persons.name", "payout_destination"], past_due: [], eventually_due: [] },
  };

  it("creates a recipient-only individual account in Nigeria", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(sandboxAccount, { status: 201 }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(
      provider.createPayeeAccount({ email: "dj@example.com", displayName: "DJ Test", entityType: "individual", idempotencyKey: "payee_profile_1" }),
    ).resolves.toEqual({
      accountId: "acct_EH2MXTOkrNaUvezJ",
      transfersActive: true,
      payoutsActive: true,
      outstanding: ["persons.name", "payout_destination"],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/accounts");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "payee_profile_1" });
    expect(JSON.parse(init?.body as string)).toEqual({
      contact_email: "dj@example.com",
      display_name: "DJ Test",
      country: "NG",
      entity_type: "individual",
      configuration: { recipient: { capabilities: { transfers: { requested: true }, payouts: { requested: true } } } },
    });
  });

  it("reads an account with GET and treats anything but active as off", async () => {
    const restricted = { ...sandboxAccount, capabilities: { ...sandboxAccount.capabilities, payouts: { status: "restricted" } } };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(restricted));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(provider.getPayeeAccount("acct_1")).resolves.toMatchObject({ transfersActive: true, payoutsActive: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/accounts/acct_1");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("creates a hosted onboarding link", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ url: "https://sandbox-connect.bachs.io/x", expires_at: "2026-11-11T00:00:00Z" }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(
      provider.createOnboardingLink({ accountId: "acct_1", returnUrl: "https://app/payouts?from=bachs", refreshUrl: "https://app/payouts/continue" }),
    ).resolves.toEqual({ url: "https://sandbox-connect.bachs.io/x", expiresAt: "2026-11-11T00:00:00Z" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      type: "onboarding",
      return_url: "https://app/payouts?from=bachs",
      refresh_url: "https://app/payouts/continue",
    });
  });

  it("turns account.updated and capability.updated into 'payee account changed'", () => {
    for (const type of ["account.updated", "capability.updated"]) {
      const body = JSON.stringify({ id: "evt_c", type, organization_id: "acct_9", account: "acct_9", data: { account: "acct_9", capability: "payouts", status: "active" } });
      expect(parse(body)).toMatchObject({ kind: "payee_account_changed", accountId: "acct_9" });
    }
  });
});

describe("settlement calls", () => {
  it("transfers to a payee account with an idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: "tr_1", status: "paid" }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(
      provider.transferToPayee({
        accountId: "acct_dj",
        amount: { amount: "5000.00", currency: "NGN" },
        group: "night_1",
        description: "Nightlife earnings",
        idempotencyKey: "transfer_p1",
      }),
    ).resolves.toEqual({ transferId: "tr_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/transfers");
    expect(init?.headers).toMatchObject({ "Idempotency-Key": "transfer_p1" });
    expect(init?.headers).not.toHaveProperty("X-Account-Id");
    expect(JSON.parse(init?.body as string)).toEqual({
      destination: "acct_dj",
      amount: "5000.00",
      currency: "NGN",
      transfer_group: "night_1",
      description: "Nightlife earnings",
    });
  });

  it("picks the default usable bank account, acting as the payee", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        destinations: [
          { id: "pd_usd", currency: "USD", is_default: true, is_usable: true },
          { id: "pd_old", currency: "NGN", is_default: false, is_usable: true },
          { id: "pd_new", currency: "NGN", is_default: true, is_usable: true },
          { id: "pd_bad", currency: "NGN", is_default: true, is_usable: false },
        ],
      }),
    );
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(provider.getDefaultPayoutDestination("acct_dj", "NGN")).resolves.toBe("pd_new");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "X-Account-Id": "acct_dj" });

    fetchMock.mockImplementation(async () => Response.json({ destinations: [] }));
    await expect(provider.getDefaultPayoutDestination("acct_dj", "NGN")).resolves.toBeNull();
  });

  it("pays out to the bank as the payee, net of the fee", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "pay_1", status: "pending", fee: "50.00" }));
    const provider = createBachsProvider({ secretKey: "sk_sandbox_key", fetch: fetchMock });
    await expect(
      provider.payoutToBank({
        accountId: "acct_dj",
        destinationId: "pd_new",
        amount: { amount: "4950.00", currency: "NGN" },
        reference: ORDER_ID,
        idempotencyKey: "payout_p1",
      }),
    ).resolves.toEqual({ payoutId: "pay_1", status: "processing", fee: "50.00" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox-api.bachs.io/v1/payouts");
    expect(init?.headers).toMatchObject({ "X-Account-Id": "acct_dj", "Idempotency-Key": "payout_p1" });
    expect(JSON.parse(init?.body as string)).toEqual({ destination: "pd_new", amount: "4950.00", reference: ORDER_ID });
  });

  it("normalises payout.paid and payout.failed", () => {
    const event = (type: string, data: object) => JSON.stringify({ id: "evt_p", type, organization_id: "acct_dj", data });
    expect(parse(event("payout.paid", { withdrawal_id: "pay_1", reference: ORDER_ID, status: "completed" }))).toMatchObject({
      kind: "payout_updated",
      providerPayoutId: "pay_1",
      payoutId: ORDER_ID,
      status: "paid",
      error: null,
    });
    expect(parse(event("payout.failed", { withdrawal_id: "pay_1", reference: null, failure_reason: "Account closed" }))).toMatchObject({
      status: "failed",
      payoutId: null,
      error: "Account closed",
    });
  });
});

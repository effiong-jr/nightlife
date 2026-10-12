import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { amountsEqual, fromMinorUnits, toMinorUnits } from "@/lib/money";
import { amountSchema, currencySchema } from "@/lib/money-schema";
import {
  type Checkout,
  type CreateCheckoutInput,
  type CreatePayeeAccountInput,
  type CreateRefundInput,
  type OnboardingLink,
  type PayeeAccount,
  type PayoutToBankInput,
  type ProviderPayout,
  type TransferToPayeeInput,
  type Refund,
  type RefundStatus,
  type PaymentEvent,
  type PaymentProvider,
  PaymentProviderError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from "./types";

// Bachs REST API (https://docs.bachs.io). Called directly with fetch: the docs
// name no official Node SDK.

export const BACHS_SANDBOX_URL = "https://sandbox-api.bachs.io";
export const BACHS_LIVE_URL = "https://api.bachs.io";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

export type BachsConfig = {
  secretKey: string;
  webhookSecret?: string;
  fetch?: typeof fetch;
  now?: () => number; // ms; injectable for tests
};

const checkoutResponseSchema = z.object({
  checkout_id: z.string().min(1),
  checkout_url: z.url(),
  expires_at: z.string(),
});

const refundResponseSchema = z.object({
  refund_id: z.string().min(1),
  status: z.string(),
});

const refundEventSchema = z.object({
  refund_id: z.string().min(1),
  reference: z.string().nullish(),
  status: z.string(),
});

// Bachs refund statuses: processing -> success | failed.
function refundStatus(status: string): RefundStatus {
  if (status === "success" || status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "processing";
}

// GET/POST /v1/accounts. Capabilities may come as a map or a list; requirement
// buckets as arrays of field keys.
const accountSchema = z.object({
  id: z.string().min(1),
  capabilities: z.unknown().optional(),
  requirements: z
    .object({
      currently_due: z.array(z.string()).optional(),
      past_due: z.array(z.string()).optional(),
    })
    .partial()
    .nullish(),
});

const accountLinkSchema = z.object({ url: z.url(), expires_at: z.string() });

function capabilityStatus(capabilities: unknown, name: string): string | null {
  if (Array.isArray(capabilities)) {
    const entry = capabilities.find(
      (c) => c && typeof c === "object" && ((c as Record<string, unknown>).name === name || (c as Record<string, unknown>).capability === name),
    ) as Record<string, unknown> | undefined;
    return typeof entry?.status === "string" ? entry.status : null;
  }
  if (capabilities && typeof capabilities === "object") {
    const entry = (capabilities as Record<string, unknown>)[name];
    if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).status === "string") {
      return (entry as Record<string, unknown>).status as string;
    }
  }
  return null;
}

function toPayeeAccount(json: unknown): PayeeAccount {
  const parsed = accountSchema.safeParse(json);
  if (!parsed.success) throw new PaymentProviderError("Unexpected Bachs account response", null, null);
  const { id, capabilities, requirements } = parsed.data;
  return {
    accountId: id,
    // Only "active" means enabled; anything else (restricted, pending...) doesn't.
    transfersActive: capabilityStatus(capabilities, "transfers") === "active",
    payoutsActive: capabilityStatus(capabilities, "payouts") === "active",
    outstanding: [...new Set([...(requirements?.past_due ?? []), ...(requirements?.currently_due ?? [])])],
  };
}

const connectEventSchema = z.object({ account: z.string().min(1) });

const transferResponseSchema = z.object({ id: z.string().min(1), status: z.string().optional() });

// Observed in the sandbox: { destinations: [{ id, currency, is_default, is_usable, ... }] }
const destinationsSchema = z.object({
  destinations: z.array(
    z.object({ id: z.string(), currency: z.string(), is_default: z.boolean().optional(), is_usable: z.boolean().optional() }),
  ),
});

const payoutResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  fee: z.union([z.string(), z.number()]).nullish(),
});

// payout.paid / payout.failed: data.withdrawal_id is the payout ID.
const payoutEventSchema = z.object({
  withdrawal_id: z.string().min(1),
  reference: z.string().nullish(),
  status: z.string().optional(),
  failure_reason: z.string().nullish(),
});

function payoutStatus(status: string): ProviderPayout["status"] {
  if (status === "completed" || status === "paid") return "paid";
  if (status === "failed") return "failed";
  return "processing";
}

const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

const collectionSchema = z.object({
  charge_id: z.string().nullish(),
  checkout_id: z.string().nullish(),
  reference: z.string().nullish(),
  status: z.string(),
  amount: amountSchema,
  currency: currencySchema,
  expected_amount: amountSchema.optional(),
  fee_bearer: z.string().nullish(),
  processing_fee: amountSchema.nullish(),
  processing_fee_currency: z.string().nullish(),
  overpaid_amount: amountSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const checkoutEventSchema = z.object({
  checkout_id: z.string().nullish(),
  reference: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

export function createBachsProvider(config: BachsConfig): PaymentProvider {
  const baseUrl = config.secretKey.startsWith("sk_live_") ? BACHS_LIVE_URL : BACHS_SANDBOX_URL;
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;

  // accountId acts as a connected account (X-Account-Id).
  const post = (path: string, body: unknown, idempotencyKey: string, accountId?: string) =>
    call("POST", path, body, idempotencyKey, accountId);
  const get = (path: string, accountId?: string) => call("GET", path, undefined, undefined, accountId);

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    accountId?: string,
  ): Promise<unknown> {
    const request = () =>
      doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(accountId ? { "X-Account-Id": accountId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    let res = await request();
    // Same key while the first attempt is still running: wait and retry once.
    if (res.status === 409 && (await peekCode(res)) === "IDEMPOTENCY_IN_PROGRESS") {
      await new Promise((r) => setTimeout(r, 1000));
      res = await request();
    }

    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const { code, detail } = errorInfo(json);
      throw new PaymentProviderError(
        `Bachs ${path} failed with ${res.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`,
        res.status,
        code,
      );
    }
    return json;
  }

  return {
    name: "bachs",

    async createCheckout(input: CreateCheckoutInput): Promise<Checkout> {
      const json = await post(
        "/v1/checkout-sessions",
        {
          pricing: { amount: input.amount.amount, currency: input.amount.currency },
          billing_currency: input.amount.currency,
          // The customer pays Bachs's processing fee on top, so we receive the
          // full order amount and the ledger splits exactly that.
          customer_bears_fee: true,
          reference: input.orderId,
          metadata: { ...input.metadata, order_id: input.orderId },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_in_minutes: input.expiresInMinutes,
        },
        input.idempotencyKey,
      );
      const parsed = checkoutResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new PaymentProviderError("Unexpected Bachs checkout response", null, null);
      }
      return {
        checkoutId: parsed.data.checkout_id,
        checkoutUrl: parsed.data.checkout_url,
        expiresAt: parsed.data.expires_at,
      };
    },

    async createRefund(input: CreateRefundInput): Promise<Refund> {
      const json = await post(
        "/v1/refunds",
        {
          charge_id: input.chargeId,
          reference: input.reference,
          reason: input.reason,
          idempotency_key: input.idempotencyKey,
          // We absorb any refund fee so the customer gets the full order amount back.
          fee_bearer: "org",
        },
        input.idempotencyKey,
      );
      const parsed = refundResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new PaymentProviderError("Unexpected Bachs refund response", null, null);
      }
      return { providerRefundId: parsed.data.refund_id, status: refundStatus(parsed.data.status) };
    },

    async createPayeeAccount(input: CreatePayeeAccountInput): Promise<PayeeAccount> {
      const json = await post(
        "/v1/accounts",
        {
          contact_email: input.email,
          display_name: input.displayName,
          country: "NG",
          entity_type: input.entityType,
          // Recipient persona: receives transfers and pays out to a bank; never
          // takes payments itself.
          configuration: {
            recipient: { capabilities: { transfers: { requested: true }, payouts: { requested: true } } },
          },
        },
        input.idempotencyKey,
      );
      return toPayeeAccount(json);
    },

    async getPayeeAccount(accountId: string): Promise<PayeeAccount> {
      return toPayeeAccount(await get(`/v1/accounts/${encodeURIComponent(accountId)}`));
    },

    async createOnboardingLink(input): Promise<OnboardingLink> {
      const json = await post(
        `/v1/accounts/${encodeURIComponent(input.accountId)}/account-links`,
        { type: "onboarding", return_url: input.returnUrl, refresh_url: input.refreshUrl },
        // A new link supersedes the old one; each request is its own operation.
        `account_link_${input.accountId}_${Date.now()}`,
      );
      const parsed = accountLinkSchema.safeParse(json);
      if (!parsed.success) throw new PaymentProviderError("Unexpected Bachs account link response", null, null);
      return { url: parsed.data.url, expiresAt: parsed.data.expires_at };
    },

    async transferToPayee(input: TransferToPayeeInput): Promise<{ transferId: string }> {
      const json = await post(
        "/v1/transfers",
        {
          destination: input.accountId,
          amount: input.amount.amount,
          currency: input.amount.currency,
          transfer_group: input.group,
          description: input.description,
        },
        input.idempotencyKey,
      );
      const parsed = transferResponseSchema.safeParse(json);
      if (!parsed.success) throw new PaymentProviderError("Unexpected Bachs transfer response", null, null);
      return { transferId: parsed.data.id };
    },

    async getDefaultPayoutDestination(accountId: string, currency: string): Promise<string | null> {
      const parsed = destinationsSchema.safeParse(await get("/v1/payouts/destinations", accountId));
      if (!parsed.success) throw new PaymentProviderError("Unexpected Bachs destinations response", null, null);
      const usable = parsed.data.destinations.filter((d) => d.currency === currency && d.is_usable !== false);
      return (usable.find((d) => d.is_default) ?? usable[0])?.id ?? null;
    },

    async payoutToBank(input: PayoutToBankInput): Promise<ProviderPayout> {
      const json = await post(
        "/v1/payouts",
        { destination: input.destinationId, amount: input.amount.amount, reference: input.reference },
        input.idempotencyKey,
        input.accountId,
      );
      const parsed = payoutResponseSchema.safeParse(json);
      if (!parsed.success) throw new PaymentProviderError("Unexpected Bachs payout response", null, null);
      return {
        payoutId: parsed.data.id,
        status: payoutStatus(parsed.data.status),
        fee: parsed.data.fee == null ? null : String(parsed.data.fee),
      };
    },

    parseWebhook(rawBody: string, headers: Headers): PaymentEvent {
      if (!config.webhookSecret) throw new WebhookNotConfiguredError();
      verifySignature(rawBody, headers, config.webhookSecret, now());

      const payload = safeJson(rawBody);
      const envelope = envelopeSchema.safeParse(payload);
      if (!envelope.success) throw new WebhookSignatureError("Malformed webhook body");
      return toPaymentEvent(envelope.data, payload);
    },
  };
}

// X-Bachs-Signature-V2: "t=<unix seconds>,v1=<hex>[,v1=<hex>...]" where each v1 is
// HMAC-SHA256(secret, "<t>.<raw body>"). Several v1 values appear during secret
// rotation; any match is accepted. Falls back to the legacy
// X-Bachs-Signature + X-Bachs-Timestamp pair.
// The docs use the X- names; the dashboard says "Bachs-Signature", so both
// spellings are accepted until a real delivery confirms which is sent.
const header = (headers: Headers, name: string) => headers.get(`x-${name}`) ?? headers.get(name);

export function verifySignature(rawBody: string, headers: Headers, secret: string, nowMs: number): void {
  let timestamp: string | undefined;
  let signatures: string[] = [];

  const v2 = header(headers, "bachs-signature-v2");
  if (v2) {
    for (const part of v2.split(",")) {
      const [key, ...rest] = part.trim().split("=");
      const value = rest.join("=");
      if (key === "t") timestamp = value;
      if (key === "v1" && value) signatures.push(value);
    }
  } else {
    timestamp = header(headers, "bachs-timestamp") ?? undefined;
    const legacy = header(headers, "bachs-signature");
    if (legacy) signatures = [legacy];
  }

  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError("Missing or malformed signature header");
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new WebhookSignatureError("Signature timestamp outside tolerance");
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"),
  );
  const valid = signatures.some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new WebhookSignatureError("Signature mismatch");
}

// Builds a valid V2 header. Used by tests and local tooling to sign payloads.
export function signPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const sig = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${sig}`;
}

function toPaymentEvent(envelope: z.infer<typeof envelopeSchema>, payload: unknown): PaymentEvent {
  const base = { eventId: envelope.id, type: envelope.type, payload };

  if (envelope.type === "collection.succeeded") {
    const data = collectionSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError("Malformed collection.succeeded data");
    const d = data.data;
    const orderId = orderIdFrom(d);
    const checkoutId = d.checkout_id ?? null;
    // charge_id can be null (e.g. test events); the event ID is unique too.
    const collectionId = d.charge_id ?? `event:${envelope.id}`;

    const succeeded = (amount: string, overpaidBy: string | null): PaymentEvent => ({
      kind: "payment_succeeded",
      ...base,
      orderId,
      checkoutId,
      collectionId,
      amount: { amount, currency: d.currency },
      overpaidBy,
    });

    // Amounts toward the order, i.e. excluding a fee the customer paid on top.
    // Without expected_amount we record what was paid; the database then
    // rejects it unless it equals the order amount.
    const paid = withoutCustomerFee(d.amount, d);
    const due = d.expected_amount && withoutCustomerFee(d.expected_amount, d);
    switch (d.status) {
      case "SUCCEEDED":
        return succeeded(paid, null);
      // ACCEPTED: "an under- or overpayment was accepted as the final outcome".
      case "OVERPAID":
      case "ACCEPTED": {
        if (!due || amountsEqual(paid, due)) return succeeded(paid, null);
        const diff = toMinorUnits(paid) - toMinorUnits(due);
        if (diff > 0n) return succeeded(due, d.overpaid_amount ?? fromMinorUnits(diff));
        return {
          kind: "payment_underpaid",
          ...base,
          orderId,
          checkoutId,
          received: { amount: paid, currency: d.currency },
        };
      }
      default:
        return { kind: "ignored", ...base };
    }
  }

  if (envelope.type === "collection.underpaid") {
    const data = collectionSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError("Malformed collection.underpaid data");
    return {
      kind: "payment_underpaid",
      ...base,
      orderId: orderIdFrom(data.data),
      checkoutId: data.data.checkout_id ?? null,
      received: { amount: data.data.amount, currency: data.data.currency },
    };
  }

  if (envelope.type === "checkout.expired") {
    const data = checkoutEventSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError("Malformed checkout.expired data");
    return {
      kind: "checkout_expired",
      ...base,
      orderId: orderIdFrom(data.data),
      checkoutId: data.data.checkout_id ?? null,
    };
  }

  if (envelope.type === "payout.paid" || envelope.type === "payout.failed") {
    const data = payoutEventSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError(`Malformed ${envelope.type} data`);
    return {
      kind: "payout_updated",
      ...base,
      providerPayoutId: data.data.withdrawal_id,
      payoutId: uuid.safeParse(data.data.reference).success ? (data.data.reference as string) : null,
      status: envelope.type === "payout.paid" ? "paid" : "failed",
      error: envelope.type === "payout.failed" ? (data.data.failure_reason ?? "Payout failed") : null,
    };
  }

  if (envelope.type === "account.updated" || envelope.type === "capability.updated") {
    const data = connectEventSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError(`Malformed ${envelope.type} data`);
    return { kind: "payee_account_changed", ...base, accountId: data.data.account };
  }

  if (envelope.type === "refund.created" || envelope.type === "refund.paid" || envelope.type === "refund.failed") {
    const data = refundEventSchema.safeParse(envelope.data);
    if (!data.success) throw new WebhookSignatureError(`Malformed ${envelope.type} data`);
    return {
      kind: "refund_updated",
      ...base,
      refundId: uuid.safeParse(data.data.reference).success ? (data.data.reference as string) : null,
      providerRefundId: data.data.refund_id,
      status: refundStatus(data.data.status),
    };
  }

  return { kind: "ignored", ...base };
}

// With fee_bearer "customer" the fee is added to the charge, so `amount` is the
// order amount plus the fee. If the fee isn't known (yet), the amount is left
// as-is and won't match the order: the payment is held for review rather than
// recorded wrong.
function withoutCustomerFee(
  amount: string,
  d: { fee_bearer?: string | null; processing_fee?: string | null; processing_fee_currency?: string | null; currency: string },
): string {
  if (d.fee_bearer !== "customer" || !d.processing_fee) return amount;
  if (d.processing_fee_currency && d.processing_fee_currency !== d.currency) return amount;
  const net = toMinorUnits(amount) - toMinorUnits(d.processing_fee);
  return net > 0n ? fromMinorUnits(net) : amount;
}

const uuid = z.uuid();

// We send the order ID as both `reference` and metadata.order_id.
function orderIdFrom(d: { reference?: string | null; metadata?: Record<string, unknown> | null }): string | null {
  const candidate = d.metadata?.order_id ?? d.reference;
  return uuid.safeParse(candidate).success ? (candidate as string) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Observed sandbox shape: { "detail": "...", "error_code": "VALIDATION_ERROR" }.
// Also tolerates { "error": { "code", "message" } }.
function errorInfo(json: unknown): { code: string | null; detail: string | null } {
  if (!json || typeof json !== "object") return { code: null, detail: null };
  const obj = json as Record<string, unknown>;
  const nested = (obj.error && typeof obj.error === "object" ? obj.error : {}) as Record<string, unknown>;
  const str = (...values: unknown[]) => (values.find((v) => typeof v === "string") as string | undefined) ?? null;
  return {
    code: str(obj.error_code, nested.code, obj.code),
    detail: str(obj.detail, nested.message, obj.message),
  };
}

async function peekCode(res: Response): Promise<string | null> {
  return errorInfo(safeJson(await res.clone().text())).code;
}

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { amountsEqual, fromMinorUnits, toMinorUnits } from "@/lib/money";
import { amountSchema, currencySchema } from "@/lib/money-schema";
import {
  type Checkout,
  type CreateCheckoutInput,
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

  async function post(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
    const request = () =>
      doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
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
export function verifySignature(rawBody: string, headers: Headers, secret: string, nowMs: number): void {
  let timestamp: string | undefined;
  let signatures: string[] = [];

  const v2 = headers.get("x-bachs-signature-v2");
  if (v2) {
    for (const part of v2.split(",")) {
      const [key, ...rest] = part.trim().split("=");
      const value = rest.join("=");
      if (key === "t") timestamp = value;
      if (key === "v1" && value) signatures.push(value);
    }
  } else {
    timestamp = headers.get("x-bachs-timestamp") ?? undefined;
    const legacy = headers.get("x-bachs-signature");
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

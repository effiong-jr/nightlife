import type { Money } from "@/lib/money";

// Provider-neutral payment interface. Everything outside lib/payments/ talks to
// this, never to a provider SDK or API directly.

export type CreateCheckoutInput = {
  orderId: string;
  amount: Money;
  successUrl: string;
  cancelUrl: string;
  expiresInMinutes: number;
  // Required: the same business operation must always reuse the same key.
  idempotencyKey: string;
  metadata?: Record<string, string>;
};

export type Checkout = {
  checkoutId: string;
  checkoutUrl: string;
  expiresAt: string;
};

// A verified webhook, normalised to what the app acts on.
export type PaymentEvent =
  | {
      kind: "payment_succeeded";
      eventId: string;
      type: string;
      orderId: string | null;
      checkoutId: string | null;
      collectionId: string;
      // The amount to record against the order. For an overpayment this is the
      // amount due; `overpaidBy` says how much extra arrived.
      amount: Money;
      overpaidBy: string | null;
      payload: unknown;
    }
  | {
      // Money arrived but less than was due. Not fulfilled; needs review.
      kind: "payment_underpaid";
      eventId: string;
      type: string;
      orderId: string | null;
      checkoutId: string | null;
      received: Money;
      payload: unknown;
    }
  | {
      kind: "checkout_expired";
      eventId: string;
      type: string;
      orderId: string | null;
      checkoutId: string | null;
      payload: unknown;
    }
  | { kind: "ignored"; eventId: string; type: string; payload: unknown };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<Checkout>;
  // Verifies the signature and parses the event. Throws WebhookSignatureError,
  // or WebhookNotConfiguredError when there's no secret to verify with.
  parseWebhook(rawBody: string, headers: Headers): PaymentEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

// No webhook secret configured: nothing can be verified, so nothing is accepted.
export class WebhookNotConfiguredError extends Error {
  constructor() {
    super("Webhook signing secret is not configured");
    this.name = "WebhookNotConfiguredError";
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

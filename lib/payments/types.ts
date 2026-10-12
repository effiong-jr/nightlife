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

export type CreateRefundInput = {
  // The provider's ID for the original payment (our payments.provider_collection_id).
  chargeId: string;
  // Our refund ID: unique per refund, echoed back in refund webhooks.
  reference: string;
  idempotencyKey: string;
  reason: string;
  // Omitted: full refund (the only kind we make).
};

export type RefundStatus = "processing" | "succeeded" | "failed";

export type Refund = { providerRefundId: string; status: RefundStatus };

// A person or venue we pay out to (Bachs: a Connect "recipient" account).
// Verification happens on the provider's hosted onboarding page.
export type PayeeAccount = {
  accountId: string;
  transfersActive: boolean;
  payoutsActive: boolean;
  // Requirement keys still wanted, e.g. "persons.per_1.id_document".
  outstanding: string[];
};

export type CreatePayeeAccountInput = {
  email: string;
  displayName: string;
  entityType: "individual" | "company";
  idempotencyKey: string;
};

export type OnboardingLink = { url: string; expiresAt: string };

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
  | {
      kind: "refund_updated";
      eventId: string;
      type: string;
      // Our refund ID (the reference we sent), when present.
      refundId: string | null;
      providerRefundId: string;
      status: RefundStatus;
      payload: unknown;
    }
  | {
      // A payee account's verification or capabilities changed: re-read it.
      kind: "payee_account_changed";
      eventId: string;
      type: string;
      accountId: string;
      payload: unknown;
    }
  | { kind: "ignored"; eventId: string; type: string; payload: unknown };

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<Checkout>;
  // Full refund of a collected payment. Asynchronous: the outcome arrives as a
  // refund_updated webhook. Throws PaymentProviderError.
  createRefund(input: CreateRefundInput): Promise<Refund>;
  createPayeeAccount(input: CreatePayeeAccountInput): Promise<PayeeAccount>;
  getPayeeAccount(accountId: string): Promise<PayeeAccount>;
  // Single-use, short-lived URL for the provider's hosted verification flow.
  createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<OnboardingLink>;
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

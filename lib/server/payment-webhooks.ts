import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type PaymentEvent,
  type PaymentProvider,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from "@/lib/payments";
import type { Database, Json } from "@/lib/supabase/database.types";
import { numeric } from "@/lib/supabase/numeric";
import { syncPayoutAccount } from "./payout-accounts";

type Deps = {
  provider: PaymentProvider;
  admin: SupabaseClient<Database>; // service_role
};

export type WebhookResult = { status: number; body: { received: boolean; result: string } };

type EventOf<K extends PaymentEvent["kind"]> = Extract<PaymentEvent, { kind: K }>;

// Postgres errors that retrying can't fix: unknown order (P0002) or an
// amount/currency mismatch (22023). These are stored for review and acknowledged.
const PERMANENT_DB_ERRORS = new Set(["P0002", "22023"]);

const ok = (result: string): WebhookResult => ({ status: 200, body: { received: true, result } });

// Webhooks are the only proof of payment. Status codes matter to the provider:
// 2xx = done, 5xx = retry later, other 4xx = never retried.
export async function handlePaymentWebhook(
  rawBody: string,
  headers: Headers,
  deps: Deps,
): Promise<WebhookResult> {
  let event: PaymentEvent;
  try {
    event = deps.provider.parseWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return { status: 400, body: { received: false, result: "invalid_signature" } };
    }
    // Our misconfiguration, not the sender's: 503 so the provider retries later.
    if (err instanceof WebhookNotConfiguredError) {
      console.error("Payment webhook received but BACHS_WEBHOOK_SECRET is not set");
      return { status: 503, body: { received: false, result: "not_configured" } };
    }
    throw err;
  }

  switch (event.kind) {
    case "payment_succeeded":
      return recordPayment(event, deps);
    case "payment_underpaid":
      return needsReview(
        event,
        `Underpaid: received ${event.received.amount} ${event.received.currency}`,
        deps,
      );
    case "checkout_expired":
      return expireCheckout(event, deps);
    case "refund_updated":
      return applyRefundUpdate(event, deps);
    case "payee_account_changed": {
      // Re-read the account rather than trusting event order (capabilities can
      // flip restricted <-> active more than once).
      const found = await syncPayoutAccount(deps, event.accountId);
      return ok(found ? "payee_synced" : "payee_unknown");
    }
    case "ignored":
      return ok("ignored");
  }
}

async function recordPayment(event: EventOf<"payment_succeeded">, deps: Deps): Promise<WebhookResult> {
  const { provider, admin } = deps;
  if (!event.orderId) return needsReview(event, "No order ID in payment metadata", deps);

  const { data, error } = await admin.rpc("record_paid_order", {
    p_provider: provider.name,
    p_event_id: event.eventId,
    p_event_type: event.type,
    p_payload: event.payload as Json,
    p_order_id: event.orderId,
    // Nullable in SQL; generated types don't mark function args nullable.
    p_checkout_id: event.checkoutId as string,
    p_collection_id: event.collectionId,
    p_amount: numeric(event.amount.amount),
    p_currency: event.amount.currency,
  });
  if (error) {
    if (error.code && PERMANENT_DB_ERRORS.has(error.code)) {
      return needsReview(event, error.message, deps);
    }
    throw error;
  }

  if (data === "recorded" && event.overpaidBy) {
    // Fulfilled at the order amount; the excess needs a manual refund.
    const { error: noteError } = await admin
      .from("webhook_events")
      .update({ error: `Overpaid by ${event.overpaidBy} ${event.amount.currency}` })
      .eq("provider", provider.name)
      .eq("provider_event_id", event.eventId);
    if (noteError) throw noteError;
  }
  return ok(data);
}

async function expireCheckout(event: EventOf<"checkout_expired">, { provider, admin }: Deps) {
  if (event.orderId) {
    const { error } = await admin
      .from("orders")
      .update({ status: "expired" })
      .eq("id", event.orderId)
      .eq("status", "pending_payment");
    if (error) throw error;
  }
  if (event.checkoutId) {
    const { error } = await admin
      .from("payments")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("provider", provider.name)
      .eq("provider_checkout_id", event.checkoutId)
      .eq("status", "pending");
    if (error) throw error;
  }
  return ok("expired");
}

// refund.created / refund.paid / refund.failed. A paid refund marks the order
// refunded; a failed one stays failed with an error for admin review.
async function applyRefundUpdate(event: EventOf<"refund_updated">, deps: Deps): Promise<WebhookResult> {
  const { provider, admin } = deps;
  let refundId = event.refundId;
  if (!refundId) {
    const { data } = await admin
      .from("refunds")
      .select("id")
      .eq("provider", provider.name)
      .eq("provider_refund_id", event.providerRefundId)
      .maybeSingle();
    refundId = data?.id ?? null;
  }
  if (!refundId) return needsReview(event, `Refund ${event.providerRefundId} not found`, deps);

  const { error } = await admin.rpc("record_refund_status", {
    p_refund_id: refundId,
    p_status: event.status,
    p_provider_refund_id: event.providerRefundId,
    // Nullable in SQL; generated types don't mark function args nullable.
    p_error: (event.status === "failed" ? "Refund failed at the provider" : null) as string,
  });
  if (error) {
    if (error.code === "P0002") return needsReview(event, error.message, deps);
    throw error;
  }

  // Keep the event for the audit trail (duplicates are harmless: final states are sticky).
  await admin.from("webhook_events").upsert(
    {
      provider: provider.name,
      provider_event_id: event.eventId,
      type: event.type,
      payload: (event.payload ?? {}) as NonNullable<Json>,
      processed_at: new Date().toISOString(),
    },
    { onConflict: "provider,provider_event_id", ignoreDuplicates: true },
  );
  return ok(`refund_${event.status}`);
}

// Stores the event with an error for admin review and acknowledges it, so the
// provider stops retrying something a retry can't fix.
async function needsReview(event: PaymentEvent, error: string, { provider, admin }: Deps) {
  const { error: dbError } = await admin.rpc("record_webhook_failure", {
    p_provider: provider.name,
    p_event_id: event.eventId,
    p_event_type: event.type,
    p_payload: event.payload as Json,
    p_error: error,
  });
  if (dbError) throw dbError;
  return ok("needs_review");
}

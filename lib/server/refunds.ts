import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type PaymentProvider, PaymentProviderError } from "@/lib/payments";
import type { Database } from "@/lib/supabase/database.types";

// Sends pending refunds to the payment provider. Run by /api/jobs/refunds,
// which pg_cron calls every minute (public.kick_refund_worker). Refund rows and
// their ledger reversals are created in the database when an order is
// rejected; this only does the provider call and records what happened.

const MAX_ATTEMPTS = 8;

const REASONS: Record<string, string> = {
  rejected_by_staff: "Request declined by the venue",
  request_timeout: "Song request not played in time",
  late_payment: "Payment arrived after the order expired",
  admin: "Refunded by Nightlife support",
};

type Deps = { admin: SupabaseClient<Database>; provider: PaymentProvider };
export type RefundRunResult = { sent: number; failed: number; retrying: number };

// Minutes until the next try: 1, 2, 4, 8, ... capped at an hour.
export function retryDelayMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

// Errors a retry won't fix: the request was understood and refused.
function isPermanent(err: unknown): boolean {
  return (
    err instanceof PaymentProviderError &&
    err.status !== null &&
    err.status >= 400 &&
    err.status < 500 &&
    ![408, 409, 429].includes(err.status)
  );
}

export async function processDueRefunds(
  { admin, provider }: Deps,
  options: { limit?: number; orderId?: string } = {},
): Promise<RefundRunResult> {
  const { data: due, error } = await admin.rpc("claim_due_refunds", {
    p_limit: options.limit ?? 20,
    ...(options.orderId ? { p_order_id: options.orderId } : {}),
  });
  if (error) throw error;

  const result: RefundRunResult = { sent: 0, failed: 0, retrying: 0 };
  for (const refund of due ?? []) {
    const fail = async (message: string) => {
      await record(admin, refund.id, "failed", null, message);
      result.failed += 1;
    };

    // Without the provider's charge ID (e.g. a test event) it can't be refunded
    // automatically; an admin has to sort it out.
    if (!refund.charge_id || refund.charge_id.startsWith("event:")) {
      await fail("No charge ID on the payment: refund it manually");
      continue;
    }

    try {
      const sent = await provider.createRefund({
        chargeId: refund.charge_id,
        reference: refund.id,
        idempotencyKey: refund.idempotency_key,
        reason: REASONS[refund.reason] ?? "Refund",
      });
      await record(admin, refund.id, sent.status, sent.providerRefundId, null);
      if (sent.status === "failed") result.failed += 1;
      else result.sent += 1;
    } catch (err) {
      const message = errorMessage(err);
      if (isPermanent(err) || refund.attempts >= MAX_ATTEMPTS) {
        await fail(message);
        continue;
      }
      const next = new Date(Date.now() + retryDelayMinutes(refund.attempts) * 60_000).toISOString();
      const { error: retryError } = await admin
        .from("refunds")
        .update({ last_error: message, next_attempt_at: next, updated_at: new Date().toISOString() })
        .eq("id", refund.id)
        .eq("status", "pending");
      if (retryError) throw retryError;
      result.retrying += 1;
    }
  }
  return result;
}

// Provider errors are Errors; Supabase errors are plain objects with a message.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return String(err);
}

async function record(
  admin: SupabaseClient<Database>,
  refundId: string,
  status: "processing" | "succeeded" | "failed",
  providerRefundId: string | null,
  message: string | null,
) {
  const { error } = await admin.rpc("record_refund_status", {
    p_refund_id: refundId,
    p_status: status,
    // Nullable in SQL; generated types don't mark function args nullable.
    p_provider_refund_id: providerRefundId as string,
    p_error: message as string,
  });
  if (error) throw error;
}

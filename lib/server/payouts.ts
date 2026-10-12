import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type PaymentProvider, PaymentProviderError } from "@/lib/payments";
import { isAmount } from "@/lib/money";
import type { Database } from "@/lib/supabase/database.types";
import { numeric } from "@/lib/supabase/numeric";

// Moves settled payouts (public.settle_night) to payees in two hops:
//   pending     -> transfer from our available balance to their Connect account
//   transferred -> payout from their account to their default bank account,
//                  amount minus the payout fee (taken from the payee)
// Outcomes of the bank payout arrive as payout.paid / payout.failed webhooks.
// Run by /api/jobs/payouts, which pg_cron calls every minute.

const MAX_ATTEMPTS = 8;

type Deps = { admin: SupabaseClient<Database>; provider: PaymentProvider };
export type PayoutRunResult = { transferred: number; submitted: number; held: number; failed: number; retrying: number };

export function payoutRetryDelayMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

// Refusals a retry won't fix. INSUFFICIENT_BALANCE is retried: our available
// balance refills as collections settle.
function isPermanent(err: unknown): boolean {
  return (
    err instanceof PaymentProviderError &&
    err.status !== null &&
    err.status >= 400 &&
    err.status < 500 &&
    ![408, 409, 429].includes(err.status) &&
    err.code !== "INSUFFICIENT_BALANCE"
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return String(err);
}

export async function processDuePayouts(
  { admin, provider }: Deps,
  options: { limit?: number; payoutId?: string } = {},
): Promise<PayoutRunResult> {
  const { data: due, error } = await admin.rpc("claim_due_payouts", {
    p_limit: options.limit ?? 20,
    ...(options.payoutId ? { p_payout_id: options.payoutId } : {}),
  });
  if (error) throw error;

  const result: PayoutRunResult = { transferred: 0, submitted: 0, held: 0, failed: 0, retrying: 0 };
  const update = async (id: string, change: Database["public"]["Tables"]["payouts"]["Update"]) => {
    const { error: updateError } = await admin
      .from("payouts")
      .update({ ...change, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) throw updateError;
  };

  for (const payout of due ?? []) {
    try {
      let stage = payout.status;

      if (stage === "pending") {
        const { transferId } = await provider.transferToPayee({
          accountId: payout.recipient_id,
          amount: { amount: payout.amount, currency: payout.currency },
          group: payout.venue_night_id,
          description: "Nightlife earnings",
          idempotencyKey: `transfer_${payout.id}`,
        });
        await update(payout.id, { status: "transferred", provider_transfer_id: transferId, last_error: null });
        result.transferred += 1;
        stage = "transferred";
      }

      if (stage === "transferred") {
        const destination = await provider.getDefaultPayoutDestination(payout.recipient_id, payout.currency);
        if (!destination) {
          // The money is safe in their account; it goes out once they add a bank.
          await update(payout.id, { status: "held", held_reason: "no_bank_account" });
          result.held += 1;
          continue;
        }
        const sent = await provider.payoutToBank({
          accountId: payout.recipient_id,
          destinationId: destination,
          amount: { amount: payout.net_amount, currency: payout.currency },
          reference: payout.id,
          idempotencyKey: `payout_${payout.id}`,
        });
        await update(payout.id, {
          status: sent.status === "paid" ? "paid" : sent.status === "failed" ? "failed" : "processing",
          provider_payout_id: sent.payoutId,
          fee: sent.fee && isAmount(sent.fee) ? numeric(sent.fee) : undefined,
          paid_at: sent.status === "paid" ? new Date().toISOString() : undefined,
          last_error: null,
        });
        result.submitted += 1;
      }
    } catch (err) {
      const message = errorMessage(err);
      if (isPermanent(err) || payout.attempts >= MAX_ATTEMPTS) {
        await update(payout.id, { status: "failed", last_error: message });
        result.failed += 1;
        continue;
      }
      await update(payout.id, {
        last_error: message,
        next_attempt_at: new Date(Date.now() + payoutRetryDelayMinutes(payout.attempts) * 60_000).toISOString(),
      });
      result.retrying += 1;
    }
  }
  return result;
}

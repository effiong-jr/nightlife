import { Suspense } from "react";
import { formatNaira } from "@/lib/money";
import { getReviewQueue, requireAdmin } from "@/lib/server/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminShell, NotAdmin } from "../_components/admin-shell";
import { ActionForm } from "../_components/forms";
import { resolveEventAction, retryPayoutAction, retryRefundAction } from "../actions";

// Things money-related that a person has to look at.
export default function ReviewPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <Review />
    </Suspense>
  );
}

const HELD_REASONS: Record<string, string> = {
  no_payout_account: "hasn't set up payouts",
  payout_account_not_ready: "verification in progress",
  no_bank_account: "no bank account on Bachs (money is in their Bachs account)",
  below_minimum: "too small to pay out after the fee",
};

async function Review() {
  if (!(await requireAdmin("/admin/review"))) return <NotAdmin />;
  const q = await getReviewQueue(createAdminClient());

  return (
    <AdminShell current="review">
      <div className="flex flex-col gap-10">
        <Section title="Failed refunds" count={q.failedRefunds.length} empty="No failed refunds.">
          {q.failedRefunds.map((r) => (
            <Row key={r.orderId} main={`${formatNaira(r.amount)} · ${r.venue} · ${r.reason.replaceAll("_", " ")}`} detail={r.error}>
              <form action={retryRefundAction.bind(null, r.orderId)}>
                <SmallButton>Retry refund</SmallButton>
              </form>
            </Row>
          ))}
        </Section>

        <Section title="Flagged payments" count={q.flaggedEvents.length} empty="Nothing flagged.">
          {q.flaggedEvents.map((e) => (
            <Row key={e.id} main={e.type} detail={e.error}>
              <ActionForm action={resolveEventAction.bind(null, e.id)} submit="Mark resolved" className="flex items-end gap-2">
                <input
                  name="note"
                  placeholder="How was it resolved?"
                  className="h-11 w-56 rounded-lg border border-input bg-transparent px-3 text-sm outline-none"
                />
              </ActionForm>
            </Row>
          ))}
        </Section>

        <Section title="Failed payouts" count={q.failedPayouts.length} empty="No failed payouts.">
          {q.failedPayouts.map((p) => (
            <Row key={p.id} main={`${formatNaira(p.amount)} to ${p.payee} (${p.party}) · ${p.venue}`} detail={p.error}>
              <form action={retryPayoutAction.bind(null, p.id)}>
                <SmallButton>Retry payout</SmallButton>
              </form>
            </Row>
          ))}
        </Section>

        <Section title="Held payouts" count={q.heldPayouts.length} empty="Nothing held.">
          {q.heldPayouts.map((p) => (
            <Row
              key={p.id}
              main={`${formatNaira(p.amount)} for ${p.payee} (${p.party}) · ${p.venue}`}
              detail={p.reason ? `Held: ${HELD_REASONS[p.reason] ?? p.reason}. Released automatically when fixed.` : null}
            />
          ))}
        </Section>
      </div>
    </AdminShell>
  );
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-semibold">
        {title} <span className="text-muted-foreground">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">{children}</ul>
      )}
    </section>
  );
}

function Row({ main, detail, children }: { main: string; detail?: string | null; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">{main}</p>
        {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      </div>
      {children}
    </li>
  );
}

function SmallButton({ children }: { children: React.ReactNode }) {
  return (
    <button type="submit" className="h-11 rounded-lg border border-border px-4 text-sm font-semibold">
      {children}
    </button>
  );
}

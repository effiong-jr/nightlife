import { Suspense } from "react";
import { getPaymentProvider } from "@/lib/payments";
import { describeRequirement, getProfilePayoutAccount, syncPayoutAccount } from "@/lib/server/payout-accounts";
import { getStaffContext } from "@/lib/server/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { NoAccess, StaffLoading, StaffShell } from "../_components/staff-shell";
import { PayoutSetupForm } from "./setup-form";

// "Get paid": a DJ/MC sets up where their earnings go. Verification (ID, NIN,
// bank account) happens on Bachs's hosted page; we never see those details.
export default function PayoutsPage({ searchParams }: PageProps<"/payouts">) {
  return (
    <Suspense fallback={<StaffLoading />}>
      <Payouts searchParams={searchParams} />
    </Suspense>
  );
}

async function Payouts({ searchParams }: Pick<PageProps<"/payouts">, "searchParams">) {
  const { venue, from } = await searchParams;
  const ctx = await getStaffContext("/payouts", ["dj", "mc"], typeof venue === "string" ? venue : undefined);
  if (!ctx) return <NoAccess role="a DJ or hype man" />;

  const admin = createAdminClient();
  const provider = getPaymentProvider();
  let account = await getProfilePayoutAccount(admin, provider.name, ctx.userId);

  // Back from Bachs: refresh now rather than wait for the webhook.
  if (account && from === "bachs") {
    try {
      await syncPayoutAccount({ admin, provider }, account.recipientId);
      account = await getProfilePayoutAccount(admin, provider.name, ctx.userId);
    } catch {
      // The webhook will catch up; show what we have.
    }
  }

  const view = account?.view;
  return (
    <StaffShell ctx={ctx} current="/payouts">
      <div className="flex max-w-xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">Get paid</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your earnings from every venue are paid to your bank the day after each night, minus Bachs&apos;s small
            payout fee. Until this is set up, they&apos;re held safely and paid once it is.
          </p>
        </div>

        {view?.status === "active" ? (
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4">
            <p className="font-semibold">Payouts are set up ✓</p>
            <p className="text-sm text-muted-foreground">Bachs has verified you. Nothing else to do.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-2xl border border-border p-4">
            {view ? (
              <>
                <p className="font-semibold">
                  {view.status === "restricted" ? "Bachs has paused your payouts" : "Verification in progress"}
                </p>
                {view.outstanding.length > 0 ? (
                  <div className="text-sm">
                    <p className="text-muted-foreground">Bachs still needs:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {view.outstanding.map((key) => (
                        <li key={key}>{describeRequirement(key)}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Bachs is checking your details. This usually takes a few minutes; we&apos;ll update this page.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                You&apos;ll verify your identity (NIN and a photo of your ID) and add your bank account on Bachs&apos;s
                secure page. It takes about 5 minutes.
              </p>
            )}
            <PayoutSetupForm hasAccount={Boolean(view)} />
          </div>
        )}
      </div>
    </StaffShell>
  );
}

"use client";

import { useActionState } from "react";
import { startPayoutSetup, type PayoutSetupState } from "./actions";

export function PayoutSetupForm({ hasAccount }: { hasAccount: boolean }) {
  const [state, action, pending] = useActionState<PayoutSetupState, FormData>(startPayoutSetup, { error: null });
  return (
    <form action={action} className="flex flex-col gap-3">
      {hasAccount ? (
        <input type="hidden" name="hasAccount" value="1" />
      ) : (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="h-12 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus:border-ring"
          />
          <span className="text-xs font-normal text-muted-foreground">Bachs sends payout receipts here.</span>
        </label>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-xl bg-emerald-500 px-4 font-semibold text-black transition active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? "Opening Bachs…" : hasAccount ? "Continue on Bachs" : "Set up payouts"}
      </button>
    </form>
  );
}

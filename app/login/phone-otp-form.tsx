"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { formatNigerianPhone } from "@/lib/phone";
import { phoneSignIn, type PhoneSignInState } from "./actions";

const initial: PhoneSignInState = { step: "phone", phone: null, error: null };

const inputClass =
  "h-12 rounded-lg border border-input bg-transparent px-3 text-lg outline-none focus:border-ring";

// Phone number -> 6-digit SMS code. `allowSignUp` lets a new DJ/MC create an
// account (only honoured on invite links).
export function PhoneOtpForm({ next, allowSignUp = false }: { next?: string; allowSignUp?: boolean }) {
  const [state, action, pending] = useActionState(phoneSignIn, initial);

  return (
    <form action={action} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      {allowSignUp && <input type="hidden" name="allowSignUp" value="1" />}

      {state.step === "phone" ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Phone number
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0803 123 4567"
            required
            className={inputClass}
          />
        </label>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to {state.phone ? formatNigerianPhone(state.phone) : "your phone"}.
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              placeholder="123456"
              required
              className={`${inputClass} tracking-[0.4em]`}
            />
          </label>
        </>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <Button type="submit" size="lg" disabled={pending} className="h-12 text-base">
        {pending ? "Please wait…" : state.step === "phone" ? "Send code" : "Sign in"}
      </Button>

      {state.step === "code" && (
        <button
          type="submit"
          name="intent"
          value="resend"
          formNoValidate
          className="text-sm text-muted-foreground underline"
        >
          Send a new code
        </button>
      )}
    </form>
  );
}

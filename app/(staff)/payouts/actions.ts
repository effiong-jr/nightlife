"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getPaymentProvider, PaymentProviderError } from "@/lib/payments";
import { appEnv } from "@/lib/server/env";
import { startProfileOnboarding } from "@/lib/server/payout-accounts";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type PayoutSetupState = { error: string | null };

// Sends the signed-in DJ/MC to Bachs's hosted verification page, creating their
// payout account first if needed. Only ever for their own profile.
export async function startPayoutSetup(_prev: PayoutSetupState, formData: FormData): Promise<PayoutSetupState> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const profileId = claims?.claims.sub;
  if (!profileId) redirect("/login?next=/payouts");

  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", profileId).single();

  const emailInput = formData.get("email");
  const email = z.email().safeParse(typeof emailInput === "string" ? emailInput.trim() : undefined);
  const needsEmail = formData.get("hasAccount") !== "1";
  if (needsEmail && !email.success) return { error: "Enter a valid email address. Bachs uses it for your payout account." };

  let url: string;
  try {
    url = await startProfileOnboarding(
      { admin: createAdminClient(), provider: getPaymentProvider() },
      {
        profileId,
        email: email.success ? email.data : "",
        displayName: profile?.display_name || "Nightlife staff",
        appUrl: appEnv().NEXT_PUBLIC_APP_URL,
      },
    );
  } catch (err) {
    console.error("Payout onboarding failed", err);
    const message =
      err instanceof PaymentProviderError && /public|localhost/i.test(err.message)
        ? "Payout setup needs the app on a public URL (Bachs won't return to localhost)."
        : "Couldn't reach Bachs. Try again in a moment.";
    return { error: message };
  }
  redirect(url);
}

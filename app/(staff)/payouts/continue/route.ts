import { redirect } from "next/navigation";
import { getPaymentProvider } from "@/lib/payments";
import { appEnv } from "@/lib/server/env";
import { getProfilePayoutAccount, startProfileOnboarding } from "@/lib/server/payout-accounts";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Bachs's refresh_url: the onboarding link expired or was used. Make a new one
// for the signed-in person's own account and send them back.
export async function GET() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const profileId = claims?.claims.sub;
  if (!profileId) redirect("/login?next=/payouts");

  const deps = { admin: createAdminClient(), provider: getPaymentProvider() };
  const existing = await getProfilePayoutAccount(deps.admin, deps.provider.name, profileId);
  if (!existing) redirect("/payouts");

  const url = await startProfileOnboarding(deps, {
    profileId,
    email: existing.view.contactEmail ?? "",
    displayName: "Nightlife staff",
    appUrl: appEnv().NEXT_PUBLIC_APP_URL,
  });
  redirect(url);
}

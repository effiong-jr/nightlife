import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentProvider } from "@/lib/payments";
import type { Database } from "@/lib/supabase/database.types";

// Payout accounts for DJs/MCs (and venues, set up by admin). The provider
// verifies people on its hosted onboarding page; we keep only the account ID
// and its state.

type Deps = { admin: SupabaseClient<Database>; provider: PaymentProvider };

export type PayoutAccountView = {
  status: "none" | "pending" | "active" | "restricted";
  outstanding: string[];
  contactEmail: string | null;
};

// Fetches the account from the provider and stores its state. Returns false if
// it isn't one of ours (e.g. an event for another platform's account).
export async function syncPayoutAccount({ admin, provider }: Deps, accountId: string): Promise<boolean> {
  const { data: row } = await admin
    .from("payout_accounts")
    .select("id")
    .eq("provider", provider.name)
    .eq("recipient_id", accountId)
    .maybeSingle();
  if (!row) return false;

  const account = await provider.getPayeeAccount(accountId);
  const { error } = await admin.rpc("record_payout_account_state", {
    p_provider: provider.name,
    p_recipient_id: accountId,
    p_transfers_active: account.transfersActive,
    p_payouts_active: account.payoutsActive,
    p_outstanding: account.outstanding,
  });
  if (error) throw error;
  return true;
}

export async function getProfilePayoutAccount(
  admin: SupabaseClient<Database>,
  providerName: string,
  profileId: string,
): Promise<{ recipientId: string; view: PayoutAccountView } | null> {
  const { data } = await admin
    .from("payout_accounts")
    .select("recipient_id, status, outstanding, contact_email")
    .eq("provider", providerName)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (!data) return null;
  return {
    recipientId: data.recipient_id,
    view: { status: data.status, outstanding: data.outstanding, contactEmail: data.contact_email },
  };
}

// Creates the profile's payout account on first use (idempotent per profile)
// and returns a fresh hosted-onboarding URL to send them to.
export async function startProfileOnboarding(
  { admin, provider }: Deps,
  input: { profileId: string; email: string; displayName: string; appUrl: string },
): Promise<string> {
  let existing = await getProfilePayoutAccount(admin, provider.name, input.profileId);
  if (!existing) {
    const account = await provider.createPayeeAccount({
      email: input.email,
      displayName: input.displayName,
      entityType: "individual",
      idempotencyKey: `payee_profile_${input.profileId}`,
    });
    const { error } = await admin.from("payout_accounts").insert({
      profile_id: input.profileId,
      provider: provider.name,
      recipient_id: account.accountId,
      contact_email: input.email,
      status: "pending",
      transfers_active: account.transfersActive,
      payouts_active: account.payoutsActive,
      outstanding: account.outstanding,
    });
    // A double submit: someone else inserted first; use theirs.
    if (error && error.code !== "23505") throw error;
    existing = await getProfilePayoutAccount(admin, provider.name, input.profileId);
    if (!existing) throw new Error("Payout account was not saved");
  }

  const link = await provider.createOnboardingLink({
    accountId: existing.recipientId,
    returnUrl: `${input.appUrl}/payouts?from=bachs`,
    refreshUrl: `${input.appUrl}/payouts/continue`,
  });
  return link.url;
}

// "persons.per_3a91.id_document" -> "Photo of your ID". Unknown keys pass
// through readable-ish rather than being hidden.
export function describeRequirement(key: string): string {
  const field = key.split(".").pop() ?? key;
  const labels: Record<string, string> = {
    name: "Your full name",
    dob: "Date of birth",
    id_number: "NIN (National Identification Number)",
    id_document: "Photo of your ID",
    bvn: "BVN",
    proof_of_address: "Proof of address",
    payout_destination: "Bank account",
    email: "Email address",
    phone: "Phone number",
    address: "Home address",
  };
  return labels[field] ?? field.replaceAll("_", " ");
}

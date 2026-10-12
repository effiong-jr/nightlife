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

// A payout account belongs to a DJ/MC profile or to a venue (club share).
export type PayeeOwner = { profileId: string } | { venueId: string };

const ownerColumn = (owner: PayeeOwner) =>
  "profileId" in owner ? (["profile_id", owner.profileId] as const) : (["venue_id", owner.venueId] as const);

export async function getProfilePayoutAccount(
  admin: SupabaseClient<Database>,
  providerName: string,
  profileId: string,
): Promise<{ recipientId: string; view: PayoutAccountView } | null> {
  return getPayoutAccount(admin, providerName, { profileId });
}

export async function getPayoutAccount(
  admin: SupabaseClient<Database>,
  providerName: string,
  owner: PayeeOwner,
): Promise<{ recipientId: string; view: PayoutAccountView } | null> {
  const [column, id] = ownerColumn(owner);
  const { data } = await admin
    .from("payout_accounts")
    .select("recipient_id, status, outstanding, contact_email")
    .eq("provider", providerName)
    .eq(column, id)
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
  deps: Deps,
  input: { profileId: string; email: string; displayName: string; appUrl: string },
): Promise<string> {
  return startPayeeOnboarding(deps, {
    owner: { profileId: input.profileId },
    email: input.email,
    displayName: input.displayName,
    returnUrl: `${input.appUrl}/payouts?from=bachs`,
    refreshUrl: `${input.appUrl}/payouts/continue`,
  });
}

// Venues are companies; admin runs their onboarding with the club owner.
export async function startVenueOnboarding(
  deps: Deps,
  input: { venueId: string; email: string; venueName: string; appUrl: string },
): Promise<string> {
  const page = `${input.appUrl}/admin/venues/${input.venueId}`;
  return startPayeeOnboarding(deps, {
    owner: { venueId: input.venueId },
    email: input.email,
    displayName: input.venueName,
    returnUrl: `${page}?from=bachs`,
    refreshUrl: `${page}?from=bachs`,
  });
}

async function startPayeeOnboarding(
  { admin, provider }: Deps,
  input: { owner: PayeeOwner; email: string; displayName: string; returnUrl: string; refreshUrl: string },
): Promise<string> {
  const isVenue = "venueId" in input.owner;
  const [, ownerId] = ownerColumn(input.owner);
  let existing = await getPayoutAccount(admin, provider.name, input.owner);
  if (!existing) {
    const account = await provider.createPayeeAccount({
      email: input.email,
      displayName: input.displayName,
      entityType: isVenue ? "company" : "individual",
      idempotencyKey: `payee_${isVenue ? "venue" : "profile"}_${ownerId}`,
    });
    const { error } = await admin.from("payout_accounts").insert({
      ...(isVenue ? { venue_id: ownerId } : { profile_id: ownerId }),
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
    existing = await getPayoutAccount(admin, provider.name, input.owner);
    if (!existing) throw new Error("Payout account was not saved");
  }

  const link = await provider.createOnboardingLink({
    accountId: existing.recipientId,
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
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

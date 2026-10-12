"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPaymentProvider, PaymentProviderError } from "@/lib/payments";
import { addManagerByPhone, createVenue, requireAdmin, setVenueStatus } from "@/lib/server/admin";
import { appEnv } from "@/lib/server/env";
import { startVenueOnboarding } from "@/lib/server/payout-accounts";
import { createAdminClient } from "@/lib/supabase/admin";

// Admin-only actions. Each checks the caller is an admin, then writes as
// service_role.

export type FormState = { error: string | null; done?: string };

async function adminOrFail(path: string) {
  const admin = await requireAdmin(path);
  if (!admin) throw new Error("Admins only");
  return admin;
}

const uuid = z.uuid();

export async function createVenueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await adminOrFail("/admin");
  const result = await createVenue(createAdminClient(), {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    address: String(formData.get("address") ?? "") || undefined,
  });
  if (!result.ok) return { error: result.error };
  redirect(`/admin/venues/${result.venueId}`);
}

export async function setVenueStatusAction(venueId: string, status: "active" | "suspended") {
  if (!uuid.safeParse(venueId).success) return;
  await adminOrFail(`/admin/venues/${venueId}`);
  await setVenueStatus(createAdminClient(), venueId, status);
  revalidatePath(`/admin/venues/${venueId}`);
}

export async function addManagerAction(venueId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!uuid.safeParse(venueId).success) return { error: "Unknown venue." };
  await adminOrFail(`/admin/venues/${venueId}`);
  const result = await addManagerByPhone(createAdminClient(), venueId, {
    phone: String(formData.get("phone") ?? ""),
    realName: String(formData.get("realName") ?? ""),
    stageName: String(formData.get("stageName") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/admin/venues/${venueId}`);
  return {
    error: null,
    done: result.created
      ? "Manager added. They can sign in at /login with their phone number."
      : "Added: this number already had an account.",
  };
}

export async function startVenuePayoutsAction(venueId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!uuid.safeParse(venueId).success) return { error: "Unknown venue." };
  await adminOrFail(`/admin/venues/${venueId}`);
  const admin = createAdminClient();
  const { data: venue } = await admin.from("venues").select("name").eq("id", venueId).single();
  const email = z.email().safeParse(String(formData.get("email") ?? "").trim());
  if (!email.success && formData.get("hasAccount") !== "1") return { error: "Enter the club's email address." };

  let url: string;
  try {
    url = await startVenueOnboarding(
      { admin, provider: getPaymentProvider() },
      { venueId, email: email.success ? email.data : "", venueName: venue?.name ?? "Venue", appUrl: appEnv().NEXT_PUBLIC_APP_URL },
    );
  } catch (err) {
    console.error("Venue payout onboarding failed", err);
    return { error: err instanceof PaymentProviderError ? err.message : "Couldn't reach Bachs. Try again." };
  }
  redirect(url);
}

export async function retryRefundAction(orderId: string) {
  if (!uuid.safeParse(orderId).success) return;
  await adminOrFail("/admin/review");
  const { error } = await createAdminClient().rpc("retry_refund", { p_order_id: orderId });
  if (error) throw error;
  revalidatePath("/admin/review");
}

export async function retryPayoutAction(payoutId: string) {
  if (!uuid.safeParse(payoutId).success) return;
  await adminOrFail("/admin/review");
  const { error } = await createAdminClient().rpc("retry_payout", { p_payout_id: payoutId });
  if (error) throw error;
  revalidatePath("/admin/review");
}

export async function resolveEventAction(eventId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!uuid.safeParse(eventId).success) return { error: "Unknown event." };
  const { userId } = await adminOrFail("/admin/review");
  const note = String(formData.get("note") ?? "").trim().slice(0, 500);
  if (!note) return { error: "Say how it was resolved." };
  const { error } = await createAdminClient()
    .from("webhook_events")
    .update({ resolved_at: new Date().toISOString(), resolved_by: userId, resolution_note: note })
    .eq("id", eventId);
  if (error) return { error: "Couldn't save." };
  revalidatePath("/admin/review");
  return { error: null, done: "Resolved." };
}

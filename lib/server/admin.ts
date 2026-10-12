import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { z } from "zod";
import { normalizeNigerianPhone } from "@/lib/phone";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

// Admin (us): onboarding venues and managers, and the review queue. Every
// admin page and action calls requireAdmin() first; the actual writes then run
// as service_role (admin can do what no venue's staff can).

type Admin = SupabaseClient<Database>;

export async function requireAdmin(path: string): Promise<{ userId: string } | null> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) redirect(`/login?next=${encodeURIComponent(path)}`);
  const { data } = await supabase.from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  return data?.is_admin ? { userId } : null;
}

export const venueInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the venue name").max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes, e.g. quilox-lagos")
    .max(60),
  address: z.string().trim().max(300).optional(),
});

export type CreateVenueResult = { ok: true; venueId: string } | { ok: false; error: string };

export async function createVenue(admin: Admin, input: z.input<typeof venueInputSchema>): Promise<CreateVenueResult> {
  const parsed = venueInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const { data, error } = await admin.rpc("create_venue", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_address: parsed.data.address ?? "",
  });
  if (error) {
    return { ok: false, error: error.code === "23505" ? "That web address (slug) is taken." : "Couldn't create the venue." };
  }
  return { ok: true, venueId: data };
}

export async function setVenueStatus(admin: Admin, venueId: string, status: "active" | "suspended" | "pending") {
  const { error } = await admin.from("venues").update({ status }).eq("id", venueId);
  if (error) throw error;
}

export const managerInputSchema = z.object({
  phone: z.string(),
  realName: z.string().trim().min(2, "Enter their real name").max(100),
  stageName: z.string().trim().min(2, "Enter the name staff will see").max(40),
});

export type AddManagerResult = { ok: true; profileId: string; created: boolean } | { ok: false; error: string };

// Adds a club manager by phone. If nobody has that number yet we create their
// account (phone already confirmed); they sign in with an SMS code.
export async function addManagerByPhone(
  admin: Admin,
  venueId: string,
  input: z.input<typeof managerInputSchema>,
): Promise<AddManagerResult> {
  const parsed = managerInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const phone = normalizeNigerianPhone(parsed.data.phone);
  if (!phone) return { ok: false, error: "Enter a Nigerian mobile number, e.g. 0803 123 4567." };

  const { data: existingId, error: findError } = await admin.rpc("find_user_by_phone", { p_phone: phone });
  if (findError) throw findError;

  let profileId = existingId;
  const created = !profileId;
  if (!profileId) {
    const { data, error } = await admin.auth.admin.createUser({
      phone,
      phone_confirm: true,
      user_metadata: { display_name: parsed.data.stageName },
    });
    if (error || !data.user) return { ok: false, error: "Couldn't create their account." };
    profileId = data.user.id;
  }

  // Fill in names only where they're missing; never overwrite someone's own.
  const { data: profile } = await admin.from("profiles").select("display_name, real_name").eq("id", profileId).single();
  const { error: profileError } = await admin
    .from("profiles")
    .update({
      display_name: profile?.display_name || parsed.data.stageName,
      real_name: profile?.real_name || parsed.data.realName,
    })
    .eq("id", profileId);
  if (profileError) throw profileError;

  const { error: staffError } = await admin
    .from("venue_staff")
    .upsert(
      { venue_id: venueId, profile_id: profileId, role: "club_manager", status: "active", source: "admin" },
      { onConflict: "venue_id,profile_id,role" },
    );
  if (staffError) throw staffError;
  return { ok: true, profileId, created };
}

export type ReviewQueue = {
  failedRefunds: { orderId: string; venue: string; amount: string; reason: string; error: string | null; at: string }[];
  flaggedEvents: { id: string; type: string; error: string; at: string }[];
  failedPayouts: { id: string; venue: string; party: string; payee: string; amount: string; error: string | null }[];
  heldPayouts: { id: string; venue: string; party: string; payee: string; amount: string; reason: string | null }[];
};

export async function getReviewQueue(admin: Admin): Promise<ReviewQueue> {
  const [refunds, events, failed, held] = await Promise.all([
    admin
      .from("refunds")
      .select("order_id, amount::text, reason, last_error, updated_at, venues(name)")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(100),
    admin
      .from("webhook_events")
      .select("id, type, error, received_at")
      .not("error", "is", null)
      .is("resolved_at", null)
      .order("received_at", { ascending: false })
      .limit(100),
    admin
      .from("payouts")
      .select("id, party, amount::text, last_error, venues(name), profiles(display_name)")
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(100),
    admin
      .from("payouts")
      .select("id, party, amount::text, held_reason, venues(name), profiles(display_name)")
      .eq("status", "held")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  for (const r of [refunds, events, failed, held]) if (r.error) throw r.error;

  // A refund retried successfully leaves its old failed row behind; only show
  // orders with no live refund.
  const failedOrders = (refunds.data ?? []).map((r) => r.order_id);
  const { data: live } = failedOrders.length
    ? await admin.from("refunds").select("order_id").in("order_id", failedOrders).neq("status", "failed")
    : { data: [] };
  const retried = new Set((live ?? []).map((r) => r.order_id));

  const payee = (p: { party: string; venues: { name: string } | null; profiles: { display_name: string } | null }) =>
    p.party === "club" ? (p.venues?.name ?? "Club") : (p.profiles?.display_name ?? "Unnamed");

  return {
    failedRefunds: (refunds.data ?? [])
      .filter((r) => !retried.has(r.order_id))
      .map((r) => ({
        orderId: r.order_id,
        venue: r.venues?.name ?? "",
        amount: r.amount,
        reason: r.reason,
        error: r.last_error,
        at: r.updated_at,
      })),
    flaggedEvents: (events.data ?? []).map((e) => ({ id: e.id, type: e.type, error: e.error ?? "", at: e.received_at })),
    failedPayouts: (failed.data ?? []).map((p) => ({
      id: p.id,
      venue: p.venues?.name ?? "",
      party: p.party,
      payee: payee(p),
      amount: p.amount,
      error: p.last_error,
    })),
    heldPayouts: (held.data ?? []).map((p) => ({
      id: p.id,
      venue: p.venues?.name ?? "",
      party: p.party,
      payee: payee(p),
      amount: p.amount,
      reason: p.held_reason,
    })),
  };
}

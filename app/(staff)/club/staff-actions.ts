"use server";

import QRCode from "qrcode";
import { z } from "zod";
import { appEnv } from "@/lib/server/env";
import { inviteUrl, newInviteToken } from "@/lib/server/invites";
import { createClient } from "@/lib/supabase/server";

// Club staff management. Runs as the signed-in manager: RLS decides what's
// allowed (only managers of that venue, only DJ/MC invites and removals).

export type CreatedInvite =
  | { ok: true; url: string; qrDataUrl: string; expiresAt: string; role: "dj" | "mc"; inviteeName: string | null }
  | { ok: false; error: string };

const inviteSchema = z.object({
  venueId: z.uuid(),
  role: z.enum(["dj", "mc"]),
  inviteeName: z.string().trim().max(60).optional(),
});

export async function createInvite(input: z.input<typeof inviteSchema>): Promise<CreatedInvite> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the role and name." };
  const { venueId, role } = parsed.data;
  const inviteeName = parsed.data.inviteeName || null;

  const { token, hash } = newInviteToken();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invites")
    .insert({ venue_id: venueId, role, token_hash: hash, invitee_name: inviteeName })
    .select("expires_at")
    .single();
  if (error || !data) return { ok: false, error: "Couldn't create the invite. Try again." };

  const url = inviteUrl(appEnv().NEXT_PUBLIC_APP_URL, token);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  return { ok: true, url, qrDataUrl, expiresAt: data.expires_at, role, inviteeName };
}

export async function cancelInvite(inviteId: string): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(inviteId).success) return { ok: false };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invites")
    .update({ cancelled_at: new Date().toISOString() })
    .eq("id", inviteId)
    .select("id");
  return { ok: !error && (data?.length ?? 0) === 1 };
}

// Their earnings already in the ledger are still paid; any set they're on ends.
export async function removeStaff(staffId: string): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(staffId).success) return { ok: false };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("venue_staff")
    .update({ status: "removed" })
    .eq("id", staffId)
    .eq("status", "active")
    .select("id");
  return { ok: !error && (data?.length ?? 0) === 1 };
}

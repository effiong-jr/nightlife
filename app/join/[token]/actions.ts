"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { checkText, FILTER_MESSAGES } from "@/lib/moderation/word-filter";
import { createClient } from "@/lib/supabase/server";

export type ProfileState = { error: string | null };

const profileSchema = z.object({
  realName: z.string().trim().min(2, "Enter your real name").max(100),
  stageName: z.string().trim().min(2, "Enter your stage name").max(40),
});

// Real name (private: never shown to attendees or next to amounts) and stage
// name (shown on the screen and in the spray picker).
export async function saveProfile(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const parsed = profileSchema.safeParse({ realName: formData.get("realName"), stageName: formData.get("stageName") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check your details." };
  const check = checkText(parsed.data.stageName);
  if (!check.ok) return { error: `Stage name: ${FILTER_MESSAGES[check.reason]}` };

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return { error: "Sign in again." };

  const { error } = await supabase
    .from("profiles")
    .update({ real_name: parsed.data.realName, display_name: parsed.data.stageName })
    .eq("id", userId);
  if (error) return { error: "Couldn't save. Try again." };

  const token = formData.get("token");
  redirect(typeof token === "string" ? `/join/${encodeURIComponent(token)}` : "/login");
}

export type AcceptState = { error: string | null };

const ACCEPT_ERRORS: [RegExp, string][] = [
  [/already used/, "This invite has already been used. Ask the club for a new link."],
  [/expired/, "This invite has expired. Ask the club for a new link."],
  [/cancelled/, "The club cancelled this invite."],
  [/venue not active/, "This venue isn't taking staff right now."],
  [/real name and stage name/, "Add your real name and stage name first."],
];

export async function acceptInvite(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const token = z.string().min(20).max(100).safeParse(formData.get("token"));
  if (!token.success) return { error: "This invite link isn't valid." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_invite", { p_token: token.data });
  if (error || !data) {
    const match = ACCEPT_ERRORS.find(([pattern]) => pattern.test(error?.message ?? ""));
    return { error: match?.[1] ?? "Couldn't accept the invite. Try again." };
  }

  const { role, venueSlug } = data as { role: string; venueSlug: string };
  redirect(`/${role === "mc" ? "mc" : "dj"}?venue=${encodeURIComponent(venueSlug)}`);
}

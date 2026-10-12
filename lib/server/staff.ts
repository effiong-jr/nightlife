import "server-only";
import { redirect } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type StaffRole = Database["public"]["Enums"]["staff_role"];

export type StaffVenue = {
  id: string;
  slug: string;
  name: string;
  requestTimeoutMinutes: number;
  roles: StaffRole[];
};

export type StaffContext = {
  userId: string;
  displayName: string;
  venue: StaffVenue;
  venues: StaffVenue[];
};

// Resolves the signed-in staff member and the venue they're working at.
// Redirects to login when signed out. Returns null when they have no venue
// with one of the allowed roles (the page shows a "no access" message).
// This is for UX only: RLS enforces access on every query.
export async function getStaffContext(
  path: string,
  allowed: StaffRole[],
  venueSlug?: string,
): Promise<StaffContext | null> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) redirect(`/login?next=${encodeURIComponent(path)}`);

  const [{ data: profile }, { data: rows, error }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
    supabase
      .from("venue_staff")
      .select("role, venues!inner(id, slug, name, request_timeout_minutes)")
      .eq("profile_id", userId)
      .eq("status", "active"),
  ]);
  if (error) throw error;

  const byVenue = new Map<string, StaffVenue>();
  for (const row of rows ?? []) {
    const v = row.venues;
    const entry = byVenue.get(v.id) ?? {
      id: v.id,
      slug: v.slug,
      name: v.name,
      requestTimeoutMinutes: v.request_timeout_minutes,
      roles: [],
    };
    entry.roles.push(row.role);
    byVenue.set(v.id, entry);
  }

  // Managers can use every staff view at their venue.
  const venues = [...byVenue.values()].filter((v) =>
    v.roles.some((r) => r === "club_manager" || allowed.includes(r)),
  );
  const venue = venues.find((v) => v.slug === venueSlug) ?? venues[0];
  if (!venue) return null;

  return { userId, displayName: profile?.display_name ?? "", venue, venues };
}

// Where a staff member lands after signing in: their most senior view.
export async function staffHomePath(): Promise<string> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) return "/login";
  const { data } = await supabase
    .from("venue_staff")
    .select("role")
    .eq("profile_id", userId)
    .eq("status", "active");
  const roles = new Set((data ?? []).map((r) => r.role));
  if (roles.has("club_manager")) return "/club";
  if (roles.has("dj")) return "/dj";
  if (roles.has("mc")) return "/mc";
  return "/club"; // shows "No access" with guidance
}

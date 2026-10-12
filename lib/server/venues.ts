import "server-only";
import type { Database } from "@/lib/supabase/database.types";
import { createPublicClient } from "@/lib/supabase/public";

export type OrderType = Database["public"]["Enums"]["order_type"];

export type VenueOption = { type: OrderType; enabled: boolean; minAmount: string };

// A DJ or MC an attendee can spray by name.
export type SprayTarget = { profileId: string; role: "dj" | "mc"; name: string; onNow: boolean };

export type PublicVenue = {
  id: string;
  slug: string;
  name: string;
  currency: string;
  requestTimeoutMinutes: number;
  isOpen: boolean;
  options: VenueOption[];
  sprayTargets: SprayTarget[];
};

const ORDER_TYPES: OrderType[] = ["spray", "screen_shoutout", "mc_shoutout", "song_request"];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// What an attendee sees after scanning the table QR. Reads as anon, so only
// active venues and their open night are visible.
export async function getPublicVenue(slug: string): Promise<PublicVenue | null> {
  if (!SLUG_RE.test(slug) || slug.length > 60) return null;
  const db = createPublicClient();

  const { data: venue, error } = await db
    .from("venues")
    .select("id, slug, name, currency, request_timeout_minutes")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!venue) return null;

  const [pricing, night, targets] = await Promise.all([
    db.from("venue_pricing").select("order_type, enabled, min_amount::text").eq("venue_id", venue.id),
    db
      .from("venue_nights")
      .select("id")
      .eq("venue_id", venue.id)
      .not("opened_at", "is", null)
      .is("closed_at", null)
      .maybeSingle(),
    db.rpc("venue_spray_targets", { p_venue_id: venue.id }),
  ]);
  if (pricing.error) throw pricing.error;
  if (night.error) throw night.error;
  if (targets.error) throw targets.error;

  const byType = new Map(pricing.data.map((p) => [p.order_type, p]));
  const options = ORDER_TYPES.flatMap((type) => {
    const p = byType.get(type);
    return p ? [{ type, enabled: p.enabled, minAmount: p.min_amount }] : [];
  });

  return {
    id: venue.id,
    slug: venue.slug,
    name: venue.name,
    currency: venue.currency,
    requestTimeoutMinutes: venue.request_timeout_minutes,
    isOpen: night.data !== null,
    options,
    sprayTargets: targets.data.flatMap((t) =>
      t.role === "dj" || t.role === "mc"
        ? [{ profileId: t.profile_id, role: t.role, name: t.name, onNow: t.on_now }]
        : [],
    ),
  };
}

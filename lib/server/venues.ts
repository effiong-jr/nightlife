import "server-only";
import type { Database } from "@/lib/supabase/database.types";
import { createPublicClient } from "@/lib/supabase/public";

export type OrderType = Database["public"]["Enums"]["order_type"];

export type VenueOption = { type: OrderType; enabled: boolean; minAmount: string };

export type PublicVenue = {
  slug: string;
  name: string;
  currency: string;
  requestTimeoutMinutes: number;
  isOpen: boolean;
  options: VenueOption[];
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

  const [pricing, night] = await Promise.all([
    db.from("venue_pricing").select("order_type, enabled, min_amount::text").eq("venue_id", venue.id),
    db
      .from("venue_nights")
      .select("id")
      .eq("venue_id", venue.id)
      .not("opened_at", "is", null)
      .is("closed_at", null)
      .maybeSingle(),
  ]);
  if (pricing.error) throw pricing.error;
  if (night.error) throw night.error;

  const byType = new Map(pricing.data.map((p) => [p.order_type, p]));
  const options = ORDER_TYPES.flatMap((type) => {
    const p = byType.get(type);
    return p ? [{ type, enabled: p.enabled, minAmount: p.min_amount }] : [];
  });

  return {
    slug: venue.slug,
    name: venue.name,
    currency: venue.currency,
    requestTimeoutMinutes: venue.request_timeout_minutes,
    isOpen: night.data !== null,
    options,
  };
}

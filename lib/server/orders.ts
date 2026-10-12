import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { toMinorUnits } from "@/lib/money";
import { amountSchema } from "@/lib/money-schema";
import { checkText, FILTER_MESSAGES } from "@/lib/moderation/word-filter";
import type { PaymentProvider } from "@/lib/payments";
import type { Database } from "@/lib/supabase/database.types";
import { numeric } from "@/lib/supabase/numeric";

const CHECKOUT_EXPIRES_IN_MINUTES = 30;
// Catches fat-finger amounts; well above any realistic single spray.
export const MAX_ORDER_AMOUNT = "10000000.00";

const text = (max: number) => z.string().trim().min(1).max(max);

export const orderInputSchema = z
  .object({
    venueSlug: z.string().min(1).max(60),
    type: z.enum(["spray", "screen_shoutout", "mc_shoutout", "song_request"]),
    nickname: text(30),
    amount: amountSchema,
    tableLabel: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9 -]{1,20}$/)
      .optional(),
    message: text(140).optional(),
    songTitle: text(120).optional(),
    songArtist: text(120).optional(),
    sprayTarget: z.enum(["dj", "mc", "celebrant"]).optional(),
    showOnLeaderboard: z.boolean().default(true),
  })
  .superRefine((o, ctx) => {
    if (toMinorUnits(o.amount) > toMinorUnits(MAX_ORDER_AMOUNT)) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: "That amount is too large" });
    }
    // Nicknames and messages can end up on the big screen or the mic.
    for (const field of ["nickname", "message"] as const) {
      const value = o[field];
      if (!value) continue;
      const check = checkText(value);
      if (!check.ok) ctx.addIssue({ code: "custom", path: [field], message: FILTER_MESSAGES[check.reason] });
    }
    if (o.type === "spray" && !o.sprayTarget) {
      ctx.addIssue({ code: "custom", path: ["sprayTarget"], message: "Choose who to spray" });
    }
    if ((o.type === "screen_shoutout" || o.type === "mc_shoutout") && !o.message) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "Write your shoutout" });
    }
    if (o.type === "song_request" && !o.songTitle) {
      ctx.addIssue({ code: "custom", path: ["songTitle"], message: "Which song?" });
    }
  });

export type OrderInput = z.input<typeof orderInputSchema>;

export class OrderRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: "venue_not_found" | "venue_closed" | "not_allowed",
  ) {
    super(message);
    this.name = "OrderRejectedError";
  }
}

type Deps = {
  // Acts as the attendee (anon): RLS decides whether the order is allowed.
  db: SupabaseClient<Database>;
  // service_role: records the checkout against the order.
  admin: SupabaseClient<Database>;
  provider: PaymentProvider;
  appUrl: string;
};

// Creates a pending order and a hosted checkout for it. The order only becomes
// paid when the provider's webhook says so (lib/server/payment-webhooks.ts).
export async function createOrderAndCheckout(
  rawInput: OrderInput,
  { db, admin, provider, appUrl }: Deps,
): Promise<{ orderId: string; checkoutUrl: string }> {
  const input = orderInputSchema.parse(rawInput);

  const { data: venue, error: venueError } = await db
    .from("venues")
    .select("id, currency")
    .eq("slug", input.venueSlug)
    .maybeSingle();
  if (venueError) throw venueError;
  if (!venue) throw new OrderRejectedError("Venue not found", "venue_not_found");

  const { data: night, error: nightError } = await db
    .from("venue_nights")
    .select("id")
    .eq("venue_id", venue.id)
    .not("opened_at", "is", null)
    .is("closed_at", null)
    .maybeSingle();
  if (nightError) throw nightError;
  if (!night) throw new OrderRejectedError("Venue is not open tonight", "venue_closed");

  // Attendees can't read orders back, so the ID is generated here.
  const orderId = randomUUID();
  const { error: insertError } = await db.from("orders").insert({
    id: orderId,
    venue_id: venue.id,
    venue_night_id: night.id,
    type: input.type,
    nickname: input.nickname,
    table_label: input.tableLabel ?? null,
    message: input.message ?? null,
    song_title: input.songTitle ?? null,
    song_artist: input.songArtist ?? null,
    spray_target: input.type === "spray" ? input.sprayTarget : null,
    show_on_leaderboard: input.showOnLeaderboard,
    amount: numeric(input.amount),
    currency: venue.currency,
  });
  if (insertError) {
    // 42501: RLS said no (below minimum, type paused, night closed...).
    if (insertError.code === "42501") {
      throw new OrderRejectedError("Order not allowed", "not_allowed");
    }
    throw insertError;
  }

  const checkout = await provider.createCheckout({
    orderId,
    amount: { amount: input.amount, currency: venue.currency },
    successUrl: `${appUrl}/v/${input.venueSlug}/orders/${orderId}`,
    cancelUrl: `${appUrl}/v/${input.venueSlug}`,
    expiresInMinutes: CHECKOUT_EXPIRES_IN_MINUTES,
    idempotencyKey: `checkout_order_${orderId}`,
    metadata: { venue_id: venue.id, order_type: input.type },
  });

  const { error: paymentError } = await admin.from("payments").insert({
    venue_id: venue.id,
    order_id: orderId,
    provider: provider.name,
    provider_checkout_id: checkout.checkoutId,
    amount: numeric(input.amount),
    currency: venue.currency,
  });
  if (paymentError) throw paymentError;

  return { orderId, checkoutUrl: checkout.checkoutUrl };
}

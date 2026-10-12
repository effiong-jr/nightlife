import "server-only";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

export type OrderReceipt = {
  id: string;
  reference: string;
  type: Database["public"]["Enums"]["order_type"];
  status: Database["public"]["Enums"]["order_status"];
  nickname: string;
  amount: string;
  createdAt: string;
  venueName: string;
  requestTimeoutMinutes: number;
  // Latest refund attempt, if the order is being refunded.
  refund: { status: "pending" | "processing" | "succeeded" | "failed"; reason: string } | null;
};

// The order ID (a random UUID from the checkout return URL) is the attendee's
// only key to their order: anon can't read orders, so this reads as the server
// and returns just what the receipt shows.
export async function getOrderReceipt(orderId: string, venueSlug: string): Promise<OrderReceipt | null> {
  if (!z.uuid().safeParse(orderId).success) return null;

  const { data, error } = await createAdminClient()
    .from("orders")
    .select(
      "id, type, status, nickname, amount::text, created_at, venues!inner(slug, name, request_timeout_minutes), refunds(status, reason, created_at)",
    )
    .eq("id", orderId)
    .eq("venues.slug", venueSlug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    reference: data.id.slice(0, 8).toUpperCase(),
    type: data.type,
    status: data.status,
    nickname: data.nickname,
    amount: data.amount,
    createdAt: data.created_at,
    venueName: data.venues.name,
    requestTimeoutMinutes: data.venues.request_timeout_minutes,
    refund:
      [...data.refunds]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((r) => ({ status: r.status, reason: r.reason }))[0] ?? null,
  };
}

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// Admin dashboard numbers (public.admin_stats). Money arrives as decimal strings.

export type Period = "tonight" | "7d" | "30d" | "all";
export const PERIODS: { id: Period; label: string }[] = [
  { id: "tonight", label: "Tonight" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

export type AdminStats = {
  gross: string;
  orders: number;
  refunded: string;
  refundCount: number;
  net: string;
  platformRevenue: string;
  avgOrder: string;
  byType: { type: string; orders: number; gross: string }[];
  venues: {
    id: string;
    name: string;
    slug: string;
    status: string;
    orders: number;
    gross: string;
    refunded: string;
    net: string;
    platformRevenue: string;
    lastNight: string | null;
  }[];
  daily: { day: string; orders: number; gross: string }[];
  payouts: { paidOut: string; inFlight: string; held: string; heldCount: number; failedCount: number };
  activeVenues: number;
  activeStaff: number;
};

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no daylight saving
const BUSINESS_DAY_STARTS_AT_HOUR = 6; // nights run until 06:00

// Start of the current Lagos business day ("tonight"): 06:00 Lagos.
export function businessDayStart(now: Date): Date {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const start = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate(), BUSINESS_DAY_STARTS_AT_HOUR);
  const startMs = start - LAGOS_OFFSET_MS;
  return new Date(now.getTime() >= startMs ? startMs : startMs - 24 * 60 * 60 * 1000);
}

export function periodRange(period: Period, now: Date): { from: Date; to: Date; days: number } {
  const day = 24 * 60 * 60 * 1000;
  switch (period) {
    case "tonight":
      return { from: businessDayStart(now), to: now, days: 14 };
    case "7d":
      return { from: new Date(now.getTime() - 7 * day), to: now, days: 7 };
    case "30d":
      return { from: new Date(now.getTime() - 30 * day), to: now, days: 30 };
    case "all":
      return { from: new Date(0), to: now, days: 30 };
  }
}

export function parsePeriod(value: unknown): Period {
  return PERIODS.some((p) => p.id === value) ? (value as Period) : "7d";
}

export async function getAdminStats(admin: SupabaseClient<Database>, period: Period, now: Date): Promise<AdminStats> {
  const { from, to, days } = periodRange(period, now);
  const { data, error } = await admin.rpc("admin_stats", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_days: days,
  });
  if (error) throw error;
  return data as unknown as AdminStats;
}

// "12.5%" from two amounts, without floats.
export function percentOf(part: string, whole: string): string {
  const p = BigInt(part.replace(".", ""));
  const w = BigInt(whole.replace(".", ""));
  if (w === 0n) return "0%";
  const tenths = (p * 1000n) / w;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

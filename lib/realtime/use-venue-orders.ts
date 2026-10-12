"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Database } from "@/lib/supabase/database.types";
import { getBrowserClient } from "@/lib/supabase/client";

type Enums = Database["public"]["Enums"];

export type StaffOrder = {
  id: string;
  type: Enums["order_type"];
  status: Enums["order_status"];
  nickname: string;
  table_label: string | null;
  message: string | null;
  song_title: string | null;
  song_artist: string | null;
  spray_target: Enums["spray_target"] | null;
  target: { display_name: string } | null;
  show_on_leaderboard: boolean;
  amount: string;
  paid_at: string | null;
  decided_at: string | null;
};

const ORDER_COLUMNS =
  "id, type, status, nickname, table_label, message, song_title, song_artist, spray_target, target:profiles!orders_target_profile_id_fkey(display_name), show_on_leaderboard, amount::text, paid_at, decided_at";
const SAFETY_POLL_MS = 30_000;

// Tonight's paid-or-later orders for a venue, kept live. Broadcasts on the
// private venue:<id> channel only say "something changed"; the list is always
// refetched through RLS, so a missed event heals on the next one (or the
// safety poll) and staff never see rows they aren't allowed to.
export function useVenueOrders(venueId: string) {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [nightId, setNightId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: night, error: nightError } = await supabase
      .from("venue_nights")
      .select("id")
      .eq("venue_id", venueId)
      .not("opened_at", "is", null)
      .is("closed_at", null)
      .maybeSingle();
    if (nightError) {
      setError(nightError.message);
      return;
    }

    let rows: StaffOrder[] = [];
    if (night) {
      const { data, error: ordersError } = await supabase
        .from("orders")
        .select(ORDER_COLUMNS)
        .eq("venue_night_id", night.id)
        .neq("status", "pending_payment")
        .neq("status", "expired")
        .order("paid_at", { ascending: true });
      if (ordersError) {
        setError(ordersError.message);
        return;
      }
      rows = data;
    }
    setNightId(night?.id ?? null);
    setOrders(rows);
    setError(null);
    setLoaded(true);
  }, [venueId]);

  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    // Coalesce bursts (e.g. several payments landing together) into one fetch.
    const scheduleRefetch = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (!cancelled) void refetch();
      }, 250);
    };

    const supabase = getBrowserClient();
    const channel = supabase.channel(`venue:${venueId}`, { config: { private: true } });
    channel.on("broadcast", { event: "order_changed" }, scheduleRefetch);

    void (async () => {
      await supabase.realtime.setAuth(); // private channels authorise with the staff JWT
      if (cancelled) return;
      channel.subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") scheduleRefetch(); // catch up after (re)connecting
      });
    })();

    scheduleRefetch();
    const poll = setInterval(scheduleRefetch, SAFETY_POLL_MS);
    return () => {
      cancelled = true;
      if (pending) clearTimeout(pending);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [venueId, refetch]);

  // Staff decisions. RLS and the status-transition trigger decide what's allowed.
  const setStatus = useCallback(
    async (orderId: string, status: "approved" | "rejected" | "fulfilled") => {
      const { error: updateError } = await getBrowserClient().from("orders").update({ status }).eq("id", orderId);
      if (updateError) {
        setError("That didn't go through. Try again.");
        return false;
      }
      await refetch();
      return true;
    },
    [refetch],
  );

  return { orders, nightId, loaded, live, error, setStatus, refetch };
}

// A shared clock that ticks every 15s, so countdowns stay current.
// The time is never read during render: it starts when the first component
// subscribes (after mount), and the server snapshot is null. Reading the clock
// while Next.js prerenders is an error with Cache Components.
const CLOCK_TICK_MS = 15_000;
let clockNow: number | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeClock(onChange: () => void) {
  clockListeners.add(onChange);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const listener of clockListeners) listener();
    }, CLOCK_TICK_MS);
  }
  return () => {
    clockListeners.delete(onChange);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

// Milliseconds since epoch, or null until mounted in the browser.
export function useNow(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => null,
  );
}

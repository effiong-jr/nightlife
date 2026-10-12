"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/client";

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
  show_on_leaderboard: boolean;
  amount: string;
  paid_at: string | null;
  decided_at: string | null;
};

const ORDER_COLUMNS =
  "id, type, status, nickname, table_label, message, song_title, song_artist, spray_target, show_on_leaderboard, amount::text, paid_at, decided_at";
const SAFETY_POLL_MS = 30_000;

// Tonight's paid-or-later orders for a venue, kept live. Broadcasts on the
// private venue:<id> channel only say "something changed"; the list is always
// refetched through RLS, so a missed event heals on the next one (or the
// safety poll) and staff never see rows they aren't allowed to.
export function useVenueOrders(venueId: string) {
  const supabase = useMemo(() => createClient(), []);
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [nightId, setNightId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
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
  }, [supabase, venueId]);

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
  }, [supabase, venueId, refetch]);

  // Staff decisions. RLS and the status-transition trigger decide what's allowed.
  const setStatus = useCallback(
    async (orderId: string, status: "approved" | "rejected" | "fulfilled") => {
      const { error: updateError } = await supabase.from("orders").update({ status }).eq("id", orderId);
      if (updateError) {
        setError("That didn't go through. Try again.");
        return false;
      }
      await refetch();
      return true;
    },
    [supabase, refetch],
  );

  return { supabase, orders, nightId, loaded, live, error, setStatus, refetch };
}

// Re-renders every `intervalMs` so countdowns stay current.
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

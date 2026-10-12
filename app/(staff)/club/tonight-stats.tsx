"use client";

import { useEffect, useState } from "react";
import { BarChart } from "@/components/charts/bar-chart";
import { formatNaira, toMinorUnits } from "@/lib/money";
import { getBrowserClient } from "@/lib/supabase/client";
import { SectionTitle } from "../_components/order-ui";

// Tonight in numbers (public.club_night_summary, manager-only). Refetched
// whenever the live order list changes (refreshKey).

type Summary = {
  gross: string;
  orders: number;
  refunded: string;
  refundCount: number;
  net: string;
  avgOrder: string;
  clubShare: string;
  staffShare: string;
  byType: { type: string; orders: number; gross: string }[];
  topTables: { table: string; orders: number; gross: string }[];
  hourly: { hour: string; orders: number; gross: string }[];
};

const TYPE_LABELS: Record<string, string> = {
  spray: "Sprays",
  screen_shoutout: "Screen shoutouts",
  mc_shoutout: "MC shoutouts",
  song_request: "Song requests",
};

// "2026-10-12T23:00:00" (Lagos wall time) -> "11pm"
const hourLabel = (iso: string) => {
  const h = Number(iso.slice(11, 13));
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
};

export function TonightStats({ nightId, refreshKey }: { nightId: string; refreshKey: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getBrowserClient()
      .rpc("club_night_summary", { p_night_id: nightId })
      .then(({ data }) => {
        if (!cancelled && data) setSummary(data as unknown as Summary);
      });
    return () => {
      cancelled = true;
    };
  }, [nightId, refreshKey]);

  if (!summary) return null;
  const share = (part: string) => {
    const whole = toMinorUnits(summary.gross);
    return whole === 0n ? "0%" : `${(toMinorUnits(part) * 100n) / whole}%`;
  };

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>Tonight in numbers</SectionTitle>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Money taken" value={formatNaira(summary.gross)} note={`${summary.orders} paid orders`} />
        <Tile label="Club's share" value={formatNaira(summary.clubShare)} note="after splits and refunds" />
        <Tile
          label="Refunds"
          value={formatNaira(summary.refunded)}
          note={`${summary.refundCount} ${summary.refundCount === 1 ? "order" : "orders"}`}
        />
        <Tile label="Average order" value={formatNaira(summary.avgOrder)} note={`DJs and MCs: ${formatNaira(summary.staffShare)}`} />
      </div>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <div className="rounded-2xl border border-border p-4">
          <h3 className="mb-3 text-sm font-semibold">Money per hour</h3>
          {summary.hourly.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <BarChart
              bucket="hour"
              points={summary.hourly.map((h) => ({ id: h.hour, label: hourLabel(h.hour), amount: h.gross, count: h.orders }))}
            />
          )}
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border p-4">
            <h3 className="mb-3 text-sm font-semibold">Top tables</h3>
            {summary.topTables.length === 0 ? (
              <p className="text-sm text-muted-foreground">No table orders yet.</p>
            ) : (
              <ol className="flex flex-col gap-2 text-sm">
                {summary.topTables.map((t, i) => (
                  <li key={t.table} className="flex justify-between gap-3">
                    <span>
                      <span className="text-muted-foreground">{i + 1}.</span> {t.table}
                      <span className="text-xs text-muted-foreground"> · {t.orders} orders</span>
                    </span>
                    <span className="font-medium tabular-nums">{formatNaira(t.gross)}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-xs text-muted-foreground">For you only: never shown on the club screen.</p>
          </div>
          <div className="rounded-2xl border border-border p-4">
            <h3 className="mb-3 text-sm font-semibold">By type</h3>
            <ul className="flex flex-col gap-2 text-sm">
              {summary.byType.map((t) => (
                <li key={t.type} className="flex justify-between gap-3">
                  <span>
                    {TYPE_LABELS[t.type] ?? t.type}
                    <span className="text-xs text-muted-foreground"> · {t.orders} · {share(t.gross)}</span>
                  </span>
                  <span className="font-medium tabular-nums">{formatNaira(t.gross)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

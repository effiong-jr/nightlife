"use client";

import { useState } from "react";
import { formatNaira, formatNairaShort, fromMinorUnits, toMinorUnits } from "@/lib/money";

// Money taken per Lagos business day. One series, so no legend: the heading
// names it. Bars anchored to the baseline with 4px rounded tops and a 2px
// gap; hover a column (full-height hit area) for the exact figures; a table
// view is available below for screen readers and exact reading.

type Day = { day: string; orders: number; gross: string };

// Fixed drawing size so the chart keeps its proportions whatever the period.
const WIDTH = 560;
const HEIGHT = 160;
const AXIS = 22;

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-NG", { day: "numeric", month: "short", timeZone: "UTC" });

export function DailyChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const minor = days.map((d) => toMinorUnits(d.gross));
  const maxMinor = minor.reduce((m, v) => (v > m ? v : m), 0n);
  // Numbers only for geometry; money labels come from the exact strings.
  const values = minor.map(Number);
  const max = Math.max(Number(maxMinor), 1);
  const width = WIDTH;
  const slot = width / days.length;
  // Thin bars with a gap; capped so a 7-day chart doesn't get slabs.
  const barWidth = Math.min(28, Math.max(4, slot - 2));
  const total = days.reduce((sum, d) => sum + toMinorUnits(d.gross), 0n);
  const maxDay = days[minor.indexOf(maxMinor)];
  const labelEvery = Math.ceil(days.length / 6);
  const active = hover === null ? null : days[hover];

  return (
    <figure className="viz flex flex-col gap-2">
      <style>{`.viz{--series-1:#3987e5;--grid:color-mix(in oklch,var(--foreground) 12%,transparent)}`}</style>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT + AXIS}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`Money taken per day over ${days.length} days. Highest: ${maxDay ? `${formatNaira(maxDay.gross)} on ${dayLabel(maxDay.day)}` : "none"}.`}
          onMouseLeave={() => setHover(null)}
        >
          {[0.5, 1].map((f) => (
            <line key={f} x1={0} x2={width} y1={HEIGHT - HEIGHT * f} y2={HEIGHT - HEIGHT * f} stroke="var(--grid)" strokeDasharray="2 4" />
          ))}
          <line x1={0} x2={width} y1={HEIGHT} y2={HEIGHT} stroke="var(--grid)" />
          {days.map((d, i) => {
            const h = values[i] === 0 ? 0 : Math.max(2, (values[i] / max) * HEIGHT);
            const x = i * slot + (slot - barWidth) / 2;
            const r = Math.min(4, barWidth / 2, h);
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
                {/* Full-height hit target, bigger than the bar */}
                <rect x={i * slot} y={0} width={slot} height={HEIGHT} fill="transparent" />
                {h > 0 && (
                  <path
                    d={`M${x},${HEIGHT} V${HEIGHT - h + r} Q${x},${HEIGHT - h} ${x + r},${HEIGHT - h} H${x + barWidth - r} Q${x + barWidth},${HEIGHT - h} ${x + barWidth},${HEIGHT - h + r} V${HEIGHT} Z`}
                    fill="var(--series-1)"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                )}
                {i % labelEvery === 0 && (
                  <text x={i * slot + slot / 2} y={HEIGHT + 15} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    {dayLabel(d.day)}
                  </text>
                )}
              </g>
            );
          })}
          <text x={0} y={-4} className="fill-muted-foreground text-[10px]">
            {formatNairaShort(fromMinorUnits(maxMinor))}
          </text>
        </svg>
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%`, transform: "translateX(-50%)" }}
          >
            <p className="font-medium text-foreground">{dayLabel(active.day)}</p>
            <p className="text-muted-foreground">
              {formatNaira(active.gross)} · {active.orders} {active.orders === 1 ? "order" : "orders"}
            </p>
          </div>
        )}
      </div>
      <figcaption className="text-xs text-muted-foreground">
        {formatNaira(fromMinorUnits(total))} over {days.length} days
      </figcaption>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 font-medium">Orders</th>
              <th className="py-1 font-medium">Money taken</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td className="py-0.5">{dayLabel(d.day)}</td>
                <td className="py-0.5">{d.orders}</td>
                <td className="py-0.5">{formatNaira(d.gross)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

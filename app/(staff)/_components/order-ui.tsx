"use client";

import { formatNaira } from "@/lib/money";
import type { StaffOrder } from "@/lib/realtime/use-venue-orders";

// Shared pieces for the DJ, MC and club views. Big tap targets: these run on a
// tablet or phone in a dark, loud room.

export function LiveBadge({ live }: { live: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className={`size-2 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-neutral-600"}`} />
      {live ? "Live" : "Connecting…"}
    </span>
  );
}

export function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
      {count !== undefined && <span className="text-foreground">{count}</span>}
    </h2>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

export function Who({ order }: { order: StaffOrder }) {
  return (
    <p className="text-sm text-muted-foreground">
      {order.nickname}
      {order.table_label && ` · ${order.table_label}`} · {formatNaira(order.amount)}
    </p>
  );
}

export function ActionButton({
  onClick,
  tone,
  children,
}: {
  onClick: () => void;
  tone: "go" | "stop" | "plain";
  children: React.ReactNode;
}) {
  const tones = {
    go: "bg-emerald-500 text-black",
    stop: "border border-border text-muted-foreground",
    plain: "border border-border",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-12 min-w-24 rounded-xl px-4 font-semibold transition active:scale-[0.98] ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function ErrorBar({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mb-4 rounded-xl border border-red-900 bg-red-950/50 p-3 text-sm text-red-300">
      {message}
    </p>
  );
}

export function minutesAgo(iso: string | null, now: number | null): string {
  if (!iso || now === null) return "";
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
}

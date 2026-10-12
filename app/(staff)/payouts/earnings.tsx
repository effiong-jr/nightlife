import { dayLabel } from "@/lib/dates";
import { formatNaira } from "@/lib/money";

// A DJ/MC's own earnings (public.my_earnings): tonight, totals, and each night
// with its payout. Song requests / MC shoutouts count once they're played/read.

export type Earnings = {
  tonight: string;
  allTime: string;
  paidOut: string;
  pending: string;
  nights: {
    nightId: string;
    date: string;
    venue: string;
    open: boolean;
    earned: string;
    payout: { amount: string; fee: string; net: string; status: string; heldReason: string | null; paidAt: string | null } | null;
  }[];
};

const HELD: Record<string, string> = {
  no_payout_account: "Held until you set up payouts",
  payout_account_not_ready: "Held until Bachs verifies you",
  no_bank_account: "Held: add your bank account on Bachs",
  below_minimum: "Too small to pay out on its own",
};

function payoutText(night: Earnings["nights"][number]): string {
  if (night.open) return "Night still open";
  const p = night.payout;
  if (!p) return "Pays the day after the night (noon)";
  switch (p.status) {
    case "paid":
      return `${formatNaira(p.net)} paid to your bank${p.paidAt ? ` on ${dayLabel(p.paidAt.slice(0, 10))}` : ""}`;
    case "held":
      return HELD[p.heldReason ?? ""] ?? "Held";
    case "failed":
      return "Payout failed: we're sorting it out";
    default:
      return `${formatNaira(p.net)} on its way to your bank`;
  }
}

export function EarningsSection({ earnings }: { earnings: Earnings }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Your earnings</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Tonight so far" value={formatNaira(earnings.tonight)} />
        <Tile label="Paid to your bank" value={formatNaira(earnings.paidOut)} />
        <Tile label="On the way or held" value={formatNaira(earnings.pending)} />
        <Tile label="Earned all time" value={formatNaira(earnings.allTime)} />
      </div>
      {earnings.nights.length === 0 ? (
        <p className="text-sm text-muted-foreground">No earnings yet. Sprays, shoutouts and songs you play show up here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border text-sm">
          {earnings.nights.map((n) => (
            <li key={`${n.nightId}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">
                  {dayLabel(n.date)} · {n.venue}
                </p>
                <p className="text-xs text-muted-foreground">{payoutText(n)}</p>
              </div>
              <span className="font-semibold tabular-nums">{formatNaira(n.earned)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Song requests count once you&apos;ve played them, MC shoutouts once you&apos;ve read them. Bachs&apos;s ₦50
        payout fee is taken from each payout.
      </p>
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

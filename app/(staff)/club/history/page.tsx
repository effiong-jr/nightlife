import { Suspense } from "react";
import { BarChart } from "@/components/charts/bar-chart";
import { dayLabel } from "@/lib/dates";
import { formatNaira } from "@/lib/money";
import { getStaffContext } from "@/lib/server/staff";
import { createClient } from "@/lib/supabase/server";
import { NoAccess, StaffLoading, StaffShell } from "../../_components/staff-shell";

// Past nights for the club: takings, the club's share and its payout, and what
// each DJ/MC earned. Manager-only (checked again in public.club_history).
export default function ClubHistoryPage({ searchParams }: PageProps<"/club/history">) {
  return (
    <Suspense fallback={<StaffLoading />}>
      <History searchParams={searchParams} />
    </Suspense>
  );
}

type History = {
  nights: {
    id: string;
    date: string;
    open: boolean;
    settled: boolean;
    orders: number;
    gross: string;
    refunded: string;
    clubShare: string;
    staffShare: string;
    clubPayout: { amount: string; status: string; heldReason: string | null; paidAt: string | null } | null;
  }[];
  staff: { profileId: string; name: string; roles: string[]; nights: number; earned: string }[];
};

const PAYOUT_LABELS: Record<string, string> = {
  held: "Held",
  pending: "Sending",
  transferred: "Sending",
  processing: "At the bank",
  paid: "Paid",
  failed: "Failed: we're on it",
};

function payoutStatus(night: History["nights"][number]): string {
  if (night.open) return "Night open";
  if (!night.settled) return "Settles at noon";
  if (!night.clubPayout) return "Nothing to pay";
  if (night.clubPayout.status === "held" && night.clubPayout.heldReason?.startsWith("no_payout")) {
    return "Held: payout account not set up";
  }
  return PAYOUT_LABELS[night.clubPayout.status] ?? night.clubPayout.status;
}

async function History({ searchParams }: Pick<PageProps<"/club/history">, "searchParams">) {
  const { venue } = await searchParams;
  const ctx = await getStaffContext("/club/history", ["club_manager"], typeof venue === "string" ? venue : undefined);
  if (!ctx || !ctx.venue.roles.includes("club_manager")) return <NoAccess role="a club manager" />;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("club_history", { p_venue_id: ctx.venue.id, p_limit: 30 });
  if (error) throw error;
  const history = data as unknown as History;
  const chronological = [...history.nights].reverse();

  return (
    <StaffShell ctx={ctx} current="/club">
      <div className="flex flex-col gap-8">
        <h1 className="text-2xl font-bold">Past nights</h1>

        <section className="rounded-2xl border border-border p-4">
          <h2 className="mb-3 text-sm font-semibold">Club&apos;s share per night</h2>
          {chronological.length === 0 ? (
            <p className="text-sm text-muted-foreground">No nights yet.</p>
          ) : (
            <BarChart
              bucket="night"
              amountLabel="Club's share"
              points={chronological.map((n) => ({ id: n.id, label: dayLabel(n.date), amount: n.clubShare, count: n.orders }))}
            />
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Nights</h2>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  {["Night", "Orders", "Money taken", "Refunds", "Club's share", "DJs & MCs", "Club payout"].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.nights.map((n) => (
                  <tr key={n.id}>
                    <td className="px-3 py-2 whitespace-nowrap">{dayLabel(n.date)}</td>
                    <td className="px-3 py-2 tabular-nums">{n.orders}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(n.gross)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(n.refunded)}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">{formatNaira(n.clubShare)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(n.staffShare)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{payoutStatus(n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">What your DJs and MCs earned (these nights)</h2>
          {history.staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing earned yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border text-sm">
              {history.staff.map((s) => (
                <li key={s.profileId} className="flex justify-between gap-3 px-4 py-3">
                  <span>
                    {s.name || "Unnamed"}{" "}
                    <span className="text-muted-foreground">
                      · {s.roles.map((r) => r.toUpperCase()).join(" & ")} · {s.nights} {s.nights === 1 ? "night" : "nights"}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums">{formatNaira(s.earned)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Paid to them directly by Nightlife the day after each night. Song requests and MC shoutouts count for
            whoever played or read them.
          </p>
        </section>
      </div>
    </StaffShell>
  );
}

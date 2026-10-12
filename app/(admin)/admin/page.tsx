import Link from "next/link";
import { Suspense } from "react";
import { formatNaira } from "@/lib/money";
import { getReviewQueue, requireAdmin } from "@/lib/server/admin";
import { getAdminStats, parsePeriod, PERIODS, percentOf } from "@/lib/server/admin-stats";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminShell, NotAdmin, StatusPill } from "./_components/admin-shell";
import { DailyChart } from "./_components/daily-chart";
import { ActionForm, Field } from "./_components/forms";
import { createVenueAction } from "./actions";

// Admin home: platform stats for a period, venues, and new venues.
export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <Admin searchParams={searchParams} />
    </Suspense>
  );
}

const TYPE_LABELS: Record<string, string> = {
  spray: "Sprays",
  screen_shoutout: "Screen shoutouts",
  mc_shoutout: "MC shoutouts",
  song_request: "Song requests",
};

async function Admin({ searchParams }: Pick<PageProps<"/admin">, "searchParams">) {
  const [{ period: periodParam }] = await Promise.all([searchParams]);
  if (!(await requireAdmin("/admin"))) return <NotAdmin />;
  const period = parsePeriod(periodParam);
  const admin = createAdminClient();
  const [stats, queue] = await Promise.all([getAdminStats(admin, period, new Date()), getReviewQueue(admin)]);
  const toReview = queue.failedRefunds.length + queue.flaggedEvents.length + queue.failedPayouts.length;
  const periodLabel = PERIODS.find((p) => p.id === period)?.label.toLowerCase();

  return (
    <AdminShell current="venues">
      <div className="flex flex-col gap-8">
        {toReview > 0 && (
          <Link href="/admin/review" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <span className="font-semibold">⚠ {toReview} item{toReview === 1 ? "" : "s"} need review</span>
            <span className="text-muted-foreground"> · failed refunds, flagged payments or failed payouts →</span>
          </Link>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Overview</h1>
          <nav className="flex gap-1 rounded-xl border border-border p-1" aria-label="Period">
            {PERIODS.map((p) => (
              <Link
                key={p.id}
                href={`/admin?period=${p.id}`}
                aria-current={p.id === period ? "page" : undefined}
                className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Money taken" value={formatNaira(stats.gross)} note={`${stats.orders} paid orders`} />
          <Tile label="Net after refunds" value={formatNaira(stats.net)} note={`avg order ${formatNaira(stats.avgOrder)}`} />
          <Tile label="Platform revenue" value={formatNaira(stats.platformRevenue)} note={`${percentOf(stats.platformRevenue, stats.net)} of net`} />
          <Tile
            label="Refunds"
            value={formatNaira(stats.refunded)}
            note={`${stats.refundCount} orders · ${percentOf(stats.refunded, stats.gross)} of money taken`}
          />
          <Tile label="Paid out to payees" value={formatNaira(stats.payouts.paidOut)} note={`in ${periodLabel}`} />
          <Tile label="Payouts in progress" value={formatNaira(stats.payouts.inFlight)} note="transferring or at the bank" />
          <Tile
            label="Held payouts"
            value={formatNaira(stats.payouts.held)}
            note={`${stats.payouts.heldCount} waiting${stats.payouts.failedCount ? ` · ${stats.payouts.failedCount} failed` : ""}`}
            href={stats.payouts.heldCount || stats.payouts.failedCount ? "/admin/review" : undefined}
          />
          <Tile label="Active venues" value={String(stats.activeVenues)} note={`${stats.activeStaff} DJs and MCs on staff`} />
        </section>

        <section className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl border border-border p-4">
            <h2 className="mb-3 text-sm font-semibold">Money taken per day</h2>
            <DailyChart days={stats.daily} />
          </div>
          <div className="rounded-2xl border border-border p-4">
            <h2 className="mb-3 text-sm font-semibold">By type, {periodLabel}</h2>
            {stats.byType.length === 0 ? (
              <p className="text-sm text-muted-foreground">No paid orders.</p>
            ) : (
              <ul className="flex flex-col gap-3 text-sm">
                {stats.byType.map((t) => (
                  <li key={t.type} className="flex justify-between gap-3">
                    <span>
                      {TYPE_LABELS[t.type] ?? t.type}
                      <span className="block text-xs text-muted-foreground">
                        {t.orders} orders · {percentOf(t.gross, stats.gross)}
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">{formatNaira(t.gross)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold">Venues</h2>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  {["Venue", "Orders", "Money taken", "Refunds", "Net", "Platform", "Last night"].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.venues.map((v) => (
                  <tr key={v.id} className="hover:bg-muted/40">
                    <td className="px-3 py-2">
                      <Link href={`/admin/venues/${v.id}`} className="flex items-center gap-2 font-medium">
                        {v.name} <StatusPill status={v.status} />
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{v.orders}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(v.gross)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(v.refunded)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(v.net)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNaira(v.platformRevenue)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{v.lastNight ?? "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="max-w-md">
          <h2 className="mb-3 font-semibold">New venue</h2>
          <ActionForm action={createVenueAction} submit="Create venue">
            <Field label="Name" name="name" required placeholder="e.g. Quilox" />
            <Field label="Web address (slug)" name="slug" required placeholder="e.g. quilox-lagos" />
            <Field label="Address" name="address" placeholder="Victoria Island, Lagos" />
          </ActionForm>
          <p className="mt-2 text-xs text-muted-foreground">
            Starts as pending with default prices and splits. Approve it once a manager and payout account are set up.
          </p>
        </section>
      </div>
    </AdminShell>
  );
}

function Tile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </>
  );
  const className = "rounded-2xl border border-border p-4";
  return href ? (
    <Link href={href} className={`${className} hover:bg-muted/40`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

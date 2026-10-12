"use client";

import { formatNaira, fromMinorUnits, toMinorUnits } from "@/lib/money";
import { type StaffOrder, useNow, useVenueOrders } from "@/lib/realtime/use-venue-orders";
import { ActionButton, Empty, ErrorBar, LiveBadge, SectionTitle, Who, minutesAgo } from "../_components/order-ui";

const TYPE_LABELS: Record<StaffOrder["type"], string> = {
  spray: "Sprays",
  screen_shoutout: "Screen shoutouts",
  mc_shoutout: "MC shoutouts",
  song_request: "Song requests",
};

export function ClubLive({ venueId, venueSlug }: { venueId: string; venueSlug: string }) {
  const { orders, nightId, loaded, live, error, setStatus } = useVenueOrders(venueId);
  const now = useNow();

  const toApprove = orders.filter((o) => o.type === "screen_shoutout" && o.status === "paid");
  // Money that's staying: excludes rejected (being refunded) and refunded orders.
  const kept = orders.filter((o) => o.status !== "rejected" && o.status !== "refunded");
  const total = fromMinorUnits(kept.reduce((sum, o) => sum + toMinorUnits(o.amount), 0n));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tonight</h1>
        <div className="flex items-center gap-4">
          <LiveBadge live={live} />
          <a
            href={`/s/${venueSlug}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium"
          >
            Open club screen ↗
          </a>
        </div>
      </div>
      <ErrorBar message={error} />

      {loaded && !nightId ? (
        <Empty>No night is open. Opening and closing nights comes with the next part of the dashboard.</Empty>
      ) : (
        <>
          <section>
            <SectionTitle count={toApprove.length}>Approve for the screen</SectionTitle>
            {toApprove.length === 0 ? (
              <Empty>No shoutouts waiting for approval.</Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {toApprove.map((o) => (
                  <li key={o.id} className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xl font-semibold">{o.message}</p>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <Who order={o} />
                      <span className="text-xs text-muted-foreground">{minutesAgo(o.paid_at, now)}</span>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <ActionButton tone="go" onClick={() => setStatus(o.id, "approved")}>
                        Show it
                      </ActionButton>
                      <ActionButton tone="stop" onClick={() => setStatus(o.id, "rejected")}>
                        Reject
                      </ActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle>Takings so far</SectionTitle>
            <div className="rounded-2xl border border-border p-4">
              <p className="text-3xl font-bold">{formatNaira(total)}</p>
              <p className="text-sm text-muted-foreground">
                {kept.length} paid {kept.length === 1 ? "order" : "orders"} · before splits and refunds
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                {(Object.keys(TYPE_LABELS) as StaffOrder["type"][]).map((type) => (
                  <div key={type} className="rounded-xl bg-muted p-3">
                    <dt className="text-muted-foreground">{TYPE_LABELS[type]}</dt>
                    <dd className="text-lg font-semibold">{kept.filter((o) => o.type === type).length}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

"use client";

import { useNow, useVenueOrders } from "@/lib/realtime/use-venue-orders";
import { ActionButton, Empty, ErrorBar, LiveBadge, SectionTitle, Who, minutesAgo } from "../_components/order-ui";
import { Lineup } from "./lineup";
import { CloseNightButton, OpenNightButton } from "./night-controls";
import { TonightStats } from "./tonight-stats";

export function ClubLive({ venueId, venueSlug }: { venueId: string; venueSlug: string }) {
  const { orders, nightId, loaded, live, error, setStatus, refetch } = useVenueOrders(venueId);
  const now = useNow();

  const toApprove = orders.filter((o) => o.type === "screen_shoutout" && o.status === "paid");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tonight</h1>
        <div className="flex items-center gap-4">
          <LiveBadge live={live} />
          <a href="/club/history" className="rounded-lg border border-border px-3 py-2 text-sm font-medium">
            Past nights
          </a>
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
        <OpenNightButton venueId={venueId} onChange={() => void refetch()} />
      ) : (
        <>
          {nightId && <Lineup venueId={venueId} nightId={nightId} />}

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

          {nightId && (
            <TonightStats nightId={nightId} refreshKey={orders.map((o) => `${o.id}:${o.status}`).join(",")} />
          )}

          {nightId && <CloseNightButton nightId={nightId} onChange={() => void refetch()} />}
        </>
      )}
    </div>
  );
}

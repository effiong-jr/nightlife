"use client";

import { useCallback, useEffect, useState } from "react";
import { formatNaira, nairaToAmount } from "@/lib/money";
import { type StaffOrder, useNow, useVenueOrders } from "@/lib/realtime/use-venue-orders";
import { getBrowserClient } from "@/lib/supabase/client";
import { numeric } from "@/lib/supabase/numeric";
import { ActionButton, Empty, ErrorBar, LiveBadge, SectionTitle, Who, minutesAgo } from "../_components/order-ui";

// The DJ always has the final say: anything can be rejected (and is refunded).
// Only a DJ can mark a song played: the DJ share goes to whoever does. Accepted
// requests stay in this venue-wide queue, so they carry over at a changeover.
export function DjQueue({
  venueId,
  requestTimeoutMinutes,
  isDj,
}: {
  venueId: string;
  requestTimeoutMinutes: number;
  isDj: boolean;
}) {
  const { orders, nightId, loaded, live, error, setStatus } = useVenueOrders(venueId);
  const now = useNow();

  const songs = orders.filter((o) => o.type === "song_request");
  const waiting = songs.filter((o) => o.status === "paid");
  const upNext = songs.filter((o) => o.status === "approved");
  const done = songs
    .filter((o) => o.status === "fulfilled" || o.status === "rejected" || o.status === "refunded")
    .slice(-5)
    .reverse();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Song requests</h1>
        <LiveBadge live={live} />
      </div>
      <ErrorBar message={error} />
      <RequestControls venueId={venueId} />

      {loaded && !nightId ? (
        <Empty>No night is open. Requests appear here once the club opens tonight.</Empty>
      ) : (
        <>
          <section>
            <SectionTitle count={waiting.length}>New requests</SectionTitle>
            {waiting.length === 0 ? (
              <Empty>No requests waiting. They&apos;ll pop up here live.</Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {waiting.map((o) => (
                  <SongCard key={o.id} order={o}>
                    <RefundCountdown order={o} timeoutMinutes={requestTimeoutMinutes} now={now} />
                    <div className="flex gap-2">
                      <ActionButton tone="go" onClick={() => setStatus(o.id, "approved")}>
                        Accept
                      </ActionButton>
                      <ActionButton tone="stop" onClick={() => setStatus(o.id, "rejected")}>
                        Reject
                      </ActionButton>
                    </div>
                  </SongCard>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle count={upNext.length}>Up next</SectionTitle>
            {upNext.length === 0 ? (
              <Empty>
                Accepted requests wait here until they&apos;re played. They carry over to the next DJ at changeover.
              </Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {upNext.map((o) => (
                  <SongCard key={o.id} order={o}>
                    <RefundCountdown order={o} timeoutMinutes={requestTimeoutMinutes} now={now} />
                    <div className="flex gap-2">
                      {isDj && (
                        <ActionButton tone="go" onClick={() => setStatus(o.id, "fulfilled")}>
                          Played
                        </ActionButton>
                      )}
                      <ActionButton tone="stop" onClick={() => setStatus(o.id, "rejected")}>
                        Drop
                      </ActionButton>
                    </div>
                  </SongCard>
                ))}
              </ul>
            )}
          </section>

          {done.length > 0 && (
            <section>
              <SectionTitle>Recent</SectionTitle>
              <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border text-sm">
                {done.map((o) => (
                  <li key={o.id} className="flex justify-between gap-3 px-4 py-3">
                    <span className="truncate">{o.song_title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {o.status === "fulfilled" ? "Played" : o.status === "refunded" ? "Refunded" : "Rejected"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SongCard({ order, children }: { order: StaffOrder; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-xl font-bold">{order.song_title}</p>
        {order.song_artist && <p className="truncate text-muted-foreground">{order.song_artist}</p>}
        <Who order={order} />
      </div>
      <div className="flex flex-col gap-2 sm:items-end">{children}</div>
    </li>
  );
}

// Requests not played within the venue's timeout are refunded automatically.
function RefundCountdown({
  order,
  timeoutMinutes,
  now,
}: {
  order: StaffOrder;
  timeoutMinutes: number;
  now: number | null;
}) {
  if (!order.paid_at || now === null) return null;
  // Capped: the browser clock may lag the database's paid_at slightly.
  const left = Math.min(
    timeoutMinutes,
    Math.ceil((Date.parse(order.paid_at) + timeoutMinutes * 60_000 - now) / 60_000),
  );
  return (
    <p className={`text-xs ${left <= 5 ? "text-amber-400" : "text-muted-foreground"}`}>
      {minutesAgo(order.paid_at, now)} ·{" "}
      {left > 0 ? `auto-refund in ${left} min` : "time's up: will be refunded"}
    </p>
  );
}

type Pricing = { enabled: boolean; min_amount: string };

// Pause requests and set the minimum price. Allowed for the DJ by RLS.
function RequestControls({ venueId }: { venueId: string }) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [minInput, setMinInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getBrowserClient()
        .from("venue_pricing")
        .select("enabled, min_amount::text")
        .eq("venue_id", venueId)
        .eq("order_type", "song_request")
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setPricing(data);
            setMinInput(data.min_amount.replace(/\.00$/, ""));
          }
        }),
    [venueId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function update(change: { enabled?: boolean; min_amount?: number }, done: string) {
    const { error } = await getBrowserClient()
      .from("venue_pricing")
      .update(change)
      .eq("venue_id", venueId)
      .eq("order_type", "song_request");
    setMessage(error ? "Couldn't save. Try again." : done);
    await load();
  }

  if (!pricing) return null;
  const minAmount = nairaToAmount(minInput);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="font-semibold">{pricing.enabled ? "Taking requests" : "Requests paused"}</p>
        <p className="text-sm text-muted-foreground">Minimum {formatNaira(pricing.min_amount)}</p>
        {message && <p className="mt-1 text-xs text-muted-foreground">{message}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-12 items-center gap-1 rounded-xl border border-border px-3">
          <span className="text-muted-foreground">₦</span>
          <input
            value={minInput}
            onChange={(e) => setMinInput(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            aria-label="Minimum song request price in naira"
            className="w-24 bg-transparent outline-none"
          />
        </label>
        <ActionButton
          tone="plain"
          onClick={() =>
            minAmount && update({ min_amount: numeric(minAmount) }, `Minimum set to ${formatNaira(minAmount)}`)
          }
        >
          Set min
        </ActionButton>
        <ActionButton
          tone={pricing.enabled ? "stop" : "go"}
          onClick={() =>
            update({ enabled: !pricing.enabled }, pricing.enabled ? "Requests paused" : "Requests open again")
          }
        >
          {pricing.enabled ? "Pause" : "Resume"}
        </ActionButton>
      </div>
    </section>
  );
}

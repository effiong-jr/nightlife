"use client";

import { useVenueOrders, useNow } from "@/lib/realtime/use-venue-orders";
import { formatNairaShort } from "@/lib/money";
import { isBigSpray, sprayHeadline, spraySubline } from "@/lib/screen/hype";
import { ActionButton, Empty, ErrorBar, LiveBadge, SectionTitle, Who, minutesAgo } from "../_components/order-ui";

// Reading a shoutout on the mic is the human approval for MC shoutouts.
export function McView({ venueId }: { venueId: string }) {
  const { orders, nightId, loaded, live, error, setStatus } = useVenueOrders(venueId);
  const now = useNow();

  const toRead = orders.filter((o) => o.type === "mc_shoutout" && o.status === "paid");
  const bigSprays = orders
    .filter((o) => o.type === "spray" && o.status !== "rejected" && o.status !== "refunded" && isBigSpray(o.amount))
    .slice(-5)
    .reverse();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">On the mic</h1>
        <LiveBadge live={live} />
      </div>
      <ErrorBar message={error} />

      {loaded && !nightId ? (
        <Empty>No night is open yet.</Empty>
      ) : (
        <>
          <section>
            <SectionTitle count={toRead.length}>Shoutouts to read</SectionTitle>
            {toRead.length === 0 ? (
              <Empty>Nothing to read right now.</Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {toRead.map((o) => (
                  <li key={o.id} className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-2xl leading-snug font-bold">{o.message}</p>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <Who order={o} />
                      <span className="text-xs text-muted-foreground">{minutesAgo(o.paid_at, now)}</span>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <ActionButton tone="go" onClick={() => setStatus(o.id, "fulfilled")}>
                        Read it ✓
                      </ActionButton>
                      <ActionButton tone="stop" onClick={() => setStatus(o.id, "rejected")}>
                        Skip
                      </ActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionTitle>Big sprays</SectionTitle>
            {bigSprays.length === 0 ? (
              <Empty>Sprays of ₦50k and up show here. Hype them!</Empty>
            ) : (
              <ul className="flex flex-col gap-3">
                {bigSprays.map((o) => {
                  const spray = {
                    id: o.id,
                    // Read aloud next to an amount: respect the leaderboard opt-out.
                    name: o.show_on_leaderboard ? o.nickname : "A big spender",
                    table: o.table_label,
                    amount: o.amount,
                    target: o.spray_target,
                    celebrant: o.spray_target === "celebrant" ? o.message : null,
                  };
                  return (
                    <li key={o.id} className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4">
                      <p className="text-lg font-bold text-amber-300">{sprayHeadline(spray)}</p>
                      <p className="font-semibold">{spraySubline(spray)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {o.nickname}
                        {o.table_label && ` · ${o.table_label}`} · {formatNairaShort(o.amount)} ·{" "}
                        {minutesAgo(o.paid_at, now)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

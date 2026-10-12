"use client";

import { useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { ActionButton } from "../_components/order-ui";

// Open tonight / close the night. Closing ends the sets and refunds anything
// that can't happen now (unplayed songs, unread or unapproved shoutouts).
// Settlement runs on closed nights. Unclosed nights auto-close at 06:00.

export function OpenNightButton({ venueId, onChange }: { venueId: string; onChange: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border p-6">
      <p className="font-semibold">No night is open</p>
      <p className="text-sm text-muted-foreground">
        Open tonight to start taking sprays, shoutouts and song requests.
      </p>
      <ActionButton
        tone="go"
        onClick={async () => {
          const { error } = await getBrowserClient().rpc("open_night", { p_venue_id: venueId });
          setMessage(error ? (/already open/.test(error.message) ? "A night is already open." : "Couldn't open tonight. Try again.") : null);
          onChange();
        }}
      >
        Open tonight
      </ActionButton>
      {message && <p className="text-sm text-destructive">{message}</p>}
    </div>
  );
}

export function CloseNightButton({ nightId, onChange }: { nightId: string; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!confirming) {
    return (
      <ActionButton tone="plain" onClick={() => setConfirming(true)}>
        Close night
      </ActionButton>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <p className="font-semibold">Close tonight?</p>
      <p className="text-sm text-muted-foreground">
        Ordering stops, the DJ and MC sets end, and anything not yet played, read or approved is refunded. Sprays and
        finished requests are kept. Earnings are paid out tomorrow at noon.
      </p>
      <div className="flex gap-2">
        <ActionButton
          tone="stop"
          onClick={async () => {
            const { data, error } = await getBrowserClient().rpc("close_night", { p_night_id: nightId });
            if (error) {
              setMessage("Couldn't close the night. Try again.");
              return;
            }
            setMessage(data ? `Closed. ${data} unfinished ${data === 1 ? "order is" : "orders are"} being refunded.` : null);
            setConfirming(false);
            onChange();
          }}
        >
          Yes, close the night
        </ActionButton>
        <ActionButton tone="plain" onClick={() => setConfirming(false)}>
          Keep it open
        </ActionButton>
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}

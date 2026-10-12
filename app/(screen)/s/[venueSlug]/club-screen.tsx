"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type ScreenSpray, sprayByline, sprayHeadline, spraySubline } from "@/lib/screen/hype";
import { createPublicClient } from "@/lib/supabase/public";

// Read from across a room: huge type, few words, bold motion.

type Shoutout = { id: string; name: string; message: string };
type Snapshot = { open: boolean; leaderboard: string[]; shoutouts: Shoutout[] };

const SPRAY_MS = 7000;
const SHOUTOUT_MS = 9000;
const SNAPSHOT_POLL_MS = 60_000;

export function ClubScreen({ venueId, venueName }: { venueId: string; venueName: string }) {
  const supabase = useMemo(() => createPublicClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot>({ open: true, leaderboard: [], shoutouts: [] });
  const [sprays, setSprays] = useState<ScreenSpray[]>([]);
  const [shoutoutIndex, setShoutoutIndex] = useState(0);
  const [live, setLive] = useState(false);

  const loadSnapshot = useCallback(() => {
    void supabase.rpc("screen_snapshot", { p_venue_id: venueId }).then(({ data }) => {
      if (data) setSnapshot(data as unknown as Snapshot);
    });
  }, [supabase, venueId]);

  useEffect(() => {
    const channel = supabase
      .channel(`screen:${venueId}`)
      .on("broadcast", { event: "spray" }, ({ payload }) => {
        setSprays((queue) => [...queue, payload as ScreenSpray]);
        loadSnapshot(); // leaderboard may have changed
      })
      .on("broadcast", { event: "shoutout" }, ({ payload }) => {
        const shoutout = payload as Shoutout;
        setSnapshot((s) => ({ ...s, shoutouts: [shoutout, ...s.shoutouts.filter((x) => x.id !== shoutout.id)] }));
        setShoutoutIndex(0);
      })
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        // Fetch on (re)connect, which also covers the first load.
        if (status === "SUBSCRIBED") loadSnapshot();
      });

    // Don't wait for Realtime to show the current state.
    const first = setTimeout(loadSnapshot, 0);
    const poll = setInterval(loadSnapshot, SNAPSHOT_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [supabase, venueId, loadSnapshot]);

  // One spray at a time, then the next in the queue.
  const current = sprays[0] ?? null;
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setSprays((queue) => queue.slice(1)), SPRAY_MS);
    return () => clearTimeout(timer);
  }, [current]);

  // Rotate approved shoutouts while no spray is showing.
  const shoutoutCount = snapshot.shoutouts.length;
  useEffect(() => {
    if (current || shoutoutCount < 2) return;
    const timer = setInterval(() => setShoutoutIndex((i) => (i + 1) % shoutoutCount), SHOUTOUT_MS);
    return () => clearInterval(timer);
  }, [current, shoutoutCount]);

  useWakeLock();

  const shoutout = snapshot.shoutouts[shoutoutIndex % Math.max(shoutoutCount, 1)] ?? null;

  return (
    <div className="relative grid h-dvh grid-cols-1 overflow-hidden bg-black text-white lg:grid-cols-[1fr_28vw]">
      <section className="relative flex flex-col items-center justify-center px-[5vw] text-center">
        {current ? (
          <SprayMoment key={current.id} spray={current} />
        ) : shoutout ? (
          <div key={shoutout.id} className="animate-[fade-up_600ms_ease-out]">
            <p className="text-[2.2vw] font-semibold tracking-widest text-amber-400 uppercase">Shoutout</p>
            <p className="mt-[2vh] text-[5vw] leading-tight font-black">{shoutout.message}</p>
            <p className="mt-[3vh] text-[2.4vw] text-neutral-400">from {shoutout.name}</p>
          </div>
        ) : (
          <Idle venueName={venueName} open={snapshot.open} />
        )}
      </section>

      <aside className="hidden flex-col justify-center gap-[3vh] border-l border-neutral-900 bg-neutral-950 px-[2.5vw] lg:flex">
        <p className="text-[1.6vw] font-semibold tracking-widest text-amber-400 uppercase">Top sprayers tonight</p>
        {snapshot.leaderboard.length === 0 ? (
          <p className="text-[1.8vw] text-neutral-500">Be the first. Scan the QR on your table.</p>
        ) : (
          <ol className="flex flex-col gap-[2vh]">
            {snapshot.leaderboard.map((name, i) => (
              <li key={name} className="flex items-baseline gap-[1vw]">
                <span className="w-[2.5vw] text-[2vw] font-black text-neutral-600">{i + 1}</span>
                <span className={`truncate font-bold ${i === 0 ? "text-[3vw] text-amber-300" : "text-[2.2vw]"}`}>
                  {name}
                </span>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <footer className="absolute bottom-[2vh] left-[2vw] flex items-center gap-2 text-[1vw] text-neutral-600">
        <span className={`size-[0.7vw] rounded-full ${live ? "bg-emerald-500" : "bg-neutral-700"}`} />
        {venueName}
      </footer>
    </div>
  );
}

function Idle({ venueName, open }: { venueName: string; open: boolean }) {
  return (
    <div className="animate-[fade-up_600ms_ease-out]">
      <p className="text-[6vw] leading-none font-black">{venueName}</p>
      <p className="mt-[4vh] text-[2.6vw] text-neutral-400">
        {open ? "Scan the QR on your table to spray, shout out or request a song" : "See you tonight"}
      </p>
    </div>
  );
}

function SprayMoment({ spray }: { spray: ScreenSpray }) {
  const byline = sprayByline(spray);
  return (
    <>
      <FallingMoney seed={spray.id} />
      <div className="relative z-10 animate-[pop-in_700ms_ease-out]">
        <p className="text-[5.5vw] leading-tight font-black">{sprayHeadline(spray)}</p>
        <p className="mt-[3vh] bg-gradient-to-b from-amber-200 to-amber-500 bg-clip-text text-[7vw] leading-none font-black text-transparent">
          {spraySubline(spray)}
        </p>
        {byline && <p className="mt-[3vh] text-[2.2vw] text-neutral-400">{byline}</p>}
      </div>
    </>
  );
}

// Stylised notes (deliberately not naira replicas), positioned from the order
// ID so every screen shows the same shower.
function notesFor(seed: string) {
  let state = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: 28 }, (_, i) => ({
    key: i,
    left: rand() * 100,
    delay: rand() * 2.5,
    duration: 3 + rand() * 2.5,
    spinFrom: rand() * 90 - 45,
    spinTo: rand() * 540 - 270,
    scale: 0.7 + rand() * 0.6,
  }));
}

function FallingMoney({ seed }: { seed: string }) {
  const notes = useMemo(() => notesFor(seed), [seed]);

  return (
    <div aria-hidden className="motion-money pointer-events-none absolute inset-0 overflow-hidden">
      {notes.map((n) => (
        <div
          key={n.key}
          className="absolute top-0 flex h-[3.2vw] w-[6.4vw] items-center justify-center rounded-[0.4vw] border border-emerald-200/40 bg-gradient-to-br from-emerald-400 to-emerald-700 text-[1.6vw] font-black text-emerald-950 shadow-lg"
          style={
            {
              left: `${n.left}%`,
              scale: n.scale,
              "--spin-from": `${n.spinFrom}deg`,
              "--spin-to": `${n.spinTo}deg`,
              animation: `money-fall ${n.duration}s linear ${n.delay}s both`,
            } as React.CSSProperties
          }
        >
          ₦
        </div>
      ))}
    </div>
  );
}

// Keep the TV/laptop awake while the screen is open, where supported.
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = await navigator.wakeLock?.request("screen");
      } catch {
        // Not supported or not allowed; the screen may sleep.
      }
    };
    void request();
    const onVisible = () => document.visibilityState === "visible" && void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, []);
}

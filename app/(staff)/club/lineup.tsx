"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { ActionButton, Empty, SectionTitle } from "../_components/order-ui";

// Tonight's lineup. Whoever is on a set when a payment lands earns that
// order's DJ/MC share (song requests and MC shoutouts go to whoever plays or
// reads them). One DJ and one MC at a time: starting a set hands over.

type Role = "dj" | "mc";
type SetRow = { id: string; profileId: string; role: Role; starts_at: string; ends_at: string | null; name: string };
type Staff = { profileId: string; role: Role; name: string };

const ROLE_LABELS: Record<Role, string> = { dj: "DJ", mc: "MC" };

export function Lineup({ venueId, nightId }: { venueId: string; nightId: string }) {
  const [sets, setSets] = useState<SetRow[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    const supabase = getBrowserClient();
    void Promise.all([
      supabase
        .from("venue_sets")
        .select("id, profile_id, role, starts_at, ends_at, profile:profiles!venue_sets_profile_id_fkey(display_name)")
        .eq("venue_night_id", nightId)
        .order("starts_at"),
      supabase
        .from("venue_staff")
        .select("profile_id, role, profile:profiles!venue_staff_profile_id_fkey(display_name)")
        .eq("venue_id", venueId)
        .eq("status", "active")
        .in("role", ["dj", "mc"]),
    ]).then(([setsResult, staffResult]) => {
      setSets(
        (setsResult.data ?? []).flatMap((s) =>
          s.role === "dj" || s.role === "mc"
            ? [
                {
                  id: s.id,
                  profileId: s.profile_id,
                  role: s.role,
                  starts_at: s.starts_at,
                  ends_at: s.ends_at,
                  name: s.profile.display_name,
                },
              ]
            : [],
        ),
      );
      setStaff(
        (staffResult.data ?? []).flatMap((s) =>
          s.role === "dj" || s.role === "mc"
            ? [{ profileId: s.profile_id, role: s.role, name: s.profile.display_name || "Unnamed" }]
            : [],
        ),
      );
    });
  }, [venueId, nightId]);

  useEffect(() => {
    load();
  }, [load]);

  // start_set opens sets from now with no end and end_set ends them now, so a
  // set without an end is the one on. (No clock read during render.)
  const onNow = (role: Role) => sets.find((s) => s.role === role && s.ends_at === null);

  async function start(person: Staff) {
    const { error } = await getBrowserClient().rpc("start_set", {
      p_venue_id: venueId,
      p_role: person.role,
      p_profile_id: person.profileId,
    });
    setMessage(error ? "Couldn't start that set. Try again." : `${person.name} is on as ${ROLE_LABELS[person.role]}.`);
    load();
  }

  async function end(set: SetRow) {
    const { error } = await getBrowserClient().rpc("end_set", { p_set_id: set.id });
    setMessage(error ? "Couldn't end that set. Try again." : `${set.name}'s set ended.`);
    load();
  }

  return (
    <section>
      <SectionTitle>Lineup</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["dj", "mc"] as const).map((role) => {
          const current = onNow(role);
          const others = staff.filter((p) => p.role === role && p.profileId !== current?.profileId);
          return (
            <div key={role} className="flex flex-col gap-3 rounded-2xl border border-border p-4">
              <div>
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {ROLE_LABELS[role]} on now
                </p>
                <p className="text-xl font-bold">{current ? current.name : "Nobody"}</p>
                {current && (
                  <p className="text-xs text-muted-foreground">
                    since{" "}
                    {new Date(current.starts_at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
              </div>
              {current && (
                <ActionButton tone="stop" onClick={() => end(current)}>
                  End set
                </ActionButton>
              )}
              {others.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {others.map((p) => (
                    <ActionButton key={p.profileId} tone="plain" onClick={() => start(p)}>
                      {current ? `Hand over to ${p.name}` : `Start ${p.name}`}
                    </ActionButton>
                  ))}
                </div>
              ) : (
                !current && <Empty>No {ROLE_LABELS[role]}s on staff yet.</Empty>
              )}
            </div>
          );
        })}
      </div>
      {message && <p className="mt-2 text-sm text-muted-foreground">{message}</p>}
    </section>
  );
}

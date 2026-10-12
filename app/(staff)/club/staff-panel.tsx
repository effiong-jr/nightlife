"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";
import { ActionButton, Empty, SectionTitle } from "../_components/order-ui";
import { cancelInvite, type CreatedInvite, createInvite, removeStaff } from "./staff-actions";

type Role = "club_manager" | "dj" | "mc";
type StaffRow = { id: string; role: Role; source: string; joined_at: string; profileId: string; stageName: string; realName: string };
type PendingInvite = { id: string; role: Role; invitee_name: string | null; expires_at: string };

const ROLE_LABELS: Record<Role, string> = { club_manager: "Manager", dj: "DJ", mc: "MC" };
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short" });

export function StaffPanel({ venueId, venueName, myUserId }: { venueId: string; venueName: string; myUserId: string }) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [created, setCreated] = useState<Extract<CreatedInvite, { ok: true }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    const supabase = getBrowserClient();
    void Promise.all([
      supabase
        .from("venue_staff")
        .select("id, role, source, joined_at, profile_id, profile:profiles!venue_staff_profile_id_fkey(display_name, real_name)")
        .eq("venue_id", venueId)
        .eq("status", "active")
        .order("joined_at"),
      supabase
        .from("invites")
        .select("id, role, invitee_name, expires_at")
        .eq("venue_id", venueId)
        .is("accepted_at", null)
        .is("cancelled_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }),
    ]).then(([staffResult, invitesResult]) => {
      setStaff(
        (staffResult.data ?? []).map((s) => ({
          id: s.id,
          role: s.role,
          source: s.source,
          joined_at: s.joined_at,
          profileId: s.profile_id,
          stageName: s.profile.display_name,
          realName: s.profile.real_name,
        })),
      );
      setInvites(invitesResult.data ?? []);
    });
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="flex flex-col gap-4">
      <SectionTitle>Staff</SectionTitle>

      <InviteForm
        venueId={venueId}
        onCreated={(invite) => {
          setCreated(invite);
          setMessage(null);
          load();
        }}
        onError={setMessage}
      />
      {message && <p className="text-sm text-destructive">{message}</p>}
      {created && <CreatedInviteCard invite={created} venueName={venueName} onDone={() => setCreated(null)} />}

      {invites.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Waiting to be accepted</p>
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {ROLE_LABELS[i.role]}
                  {i.invitee_name && ` · ${i.invitee_name}`}
                  <span className="text-muted-foreground"> · expires {dateLabel(i.expires_at)}</span>
                </span>
                <ActionButton
                  tone="stop"
                  onClick={async () => {
                    const result = await cancelInvite(i.id);
                    setMessage(result.ok ? null : "Couldn't cancel that invite.");
                    load();
                  }}
                >
                  Cancel
                </ActionButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      {staff.length === 0 ? (
        <Empty>No staff yet.</Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
          {staff.map((s) => (
            <StaffItem
              key={s.id}
              row={s}
              canRemove={s.role !== "club_manager" && s.profileId !== myUserId}
              onRemoved={load}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function StaffItem({ row, canRemove, onRemoved }: { row: StaffRow; canRemove: boolean; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {row.stageName || "Unnamed"} <span className="text-sm text-muted-foreground">· {ROLE_LABELS[row.role]}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {row.realName || "No real name yet"} · joined {dateLabel(row.joined_at)} by {row.source}
        </p>
      </div>
      {canRemove &&
        (confirming ? (
          <div className="flex gap-2">
            <ActionButton
              tone="stop"
              onClick={async () => {
                await removeStaff(row.id);
                onRemoved();
              }}
            >
              Confirm remove
            </ActionButton>
            <ActionButton tone="plain" onClick={() => setConfirming(false)}>
              Keep
            </ActionButton>
          </div>
        ) : (
          <ActionButton tone="plain" onClick={() => setConfirming(true)}>
            Remove
          </ActionButton>
        ))}
    </li>
  );
}

function InviteForm({
  venueId,
  onCreated,
  onError,
}: {
  venueId: string;
  onCreated: (invite: Extract<CreatedInvite, { ok: true }>) => void;
  onError: (message: string) => void;
}) {
  const [role, setRole] = useState<"dj" | "mc">("dj");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const result = await createInvite({ venueId, role, inviteeName: name });
        setPending(false);
        if (result.ok) {
          setName("");
          onCreated(result);
        } else {
          onError(result.error);
        }
      }}
    >
      <div className="flex gap-2">
        {(["dj", "mc"] as const).map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={role === r}
            onClick={() => setRole(r)}
            className="h-12 rounded-xl border border-border px-4 font-semibold aria-pressed:border-foreground aria-pressed:bg-muted"
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>
      <label className="flex flex-1 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name (optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="e.g. DJ Spinall"
          className="h-12 rounded-xl border border-border bg-transparent px-3 outline-none focus:border-ring"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-xl bg-emerald-500 px-4 font-semibold text-black transition active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create invite"}
      </button>
    </form>
  );
}

function CreatedInviteCard({
  invite,
  venueName,
  onDone,
}: {
  invite: Extract<CreatedInvite, { ok: true }>;
  venueName: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const roleName = invite.role === "dj" ? "DJ" : "hype man";
  const text = `${invite.inviteeName ? `Hi ${invite.inviteeName}, you` : "You"}'re invited to join ${venueName} as ${roleName} on Nightlife. Open this link to accept (works once, expires in 7 days): ${invite.url}`;

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-4 sm:flex-row">
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
      <img src={invite.qrDataUrl} alt="Invite QR code" className="size-40 rounded-lg bg-white p-1" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <p className="font-semibold">
            Invite link for a {roleName}
            {invite.inviteeName && ` (${invite.inviteeName})`}
          </p>
          <p className="text-xs text-muted-foreground">
            Works once, expires in 7 days. Copy it now: for security we don&apos;t show it again (you can cancel it
            and make a new one).
          </p>
        </div>
        <p className="truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">{invite.url}</p>
        <div className="flex flex-wrap gap-2">
          <a
            href={`https://wa.me/?text=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noreferrer"
            className="flex h-12 items-center rounded-xl bg-emerald-500 px-4 font-semibold text-black"
          >
            Share on WhatsApp
          </a>
          <ActionButton
            tone="plain"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite.url);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </ActionButton>
          <ActionButton tone="stop" onClick={onDone}>
            Done
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

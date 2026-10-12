"use client";

import { useState } from "react";
import { formatNaira, nairaToAmount, toMinorUnits } from "@/lib/money";
import { checkText, FILTER_MESSAGES } from "@/lib/moderation/word-filter";
import type { OrderType, SprayTarget, VenueOption } from "@/lib/server/venues";

// Attendee checkout: choose -> details -> amount -> nickname -> pay.
// Deliberately dependency-free (no UI kit, no Zod) to stay light on weak signal.
// The server re-validates everything.

// "everyone" = untargeted spray; otherwise "<profileId>:<role>" (someone can be
// staff as both DJ and MC).
type SprayChoice = "everyone" | string;
const choiceKey = (t: SprayTarget) => `${t.profileId}:${t.role}`;

const TYPES: Record<OrderType, { emoji: string; title: string; blurb: string }> = {
  spray: { emoji: "💸", title: "Spray", blurb: "Make it rain on the DJ, the hype man or the whole place" },
  screen_shoutout: { emoji: "📺", title: "Screen shoutout", blurb: "Your message on the big screen" },
  mc_shoutout: { emoji: "🎤", title: "MC shoutout", blurb: "The hype man calls it on the mic" },
  song_request: { emoji: "🎵", title: "Request a song", blurb: "The DJ decides what plays" },
};

const ROLE_LABELS = { dj: "DJ", mc: "Hype man" } as const;

const PRESET_LADDER = ["1000", "2000", "5000", "10000", "20000", "50000", "100000", "200000"];
const NICKNAME_KEY = "nightlife:nickname";
const MAX_MESSAGE = 140;

type Fields = "nickname" | "message" | "songTitle" | "amount" | "sprayTarget" | "form";
type Errors = Partial<Record<Fields, string>>;

export function OrderForm({
  venueSlug,
  tableLabel,
  options,
  sprayTargets,
  requestTimeoutMinutes,
}: {
  venueSlug: string;
  tableLabel: string | null;
  options: VenueOption[];
  sprayTargets: SprayTarget[];
  requestTimeoutMinutes: number;
}) {
  const [type, setType] = useState<OrderType | null>(null);
  const [sprayChoice, setSprayChoice] = useState<SprayChoice | null>(null);
  const [message, setMessage] = useState("");
  const [songTitle, setSongTitle] = useState("");
  const [songArtist, setSongArtist] = useState("");
  const [preset, setPreset] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [nickname, setNickname] = useState("");
  const [showOnLeaderboard, setShowOnLeaderboard] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);

  const option = options.find((o) => o.type === type) ?? null;
  const minAmount = option?.minAmount ?? null;
  const presets = minAmount ? presetsFor(minAmount) : [];
  const amount = custom ? nairaToAmount(custom) : preset;
  const needsMessage = type === "screen_shoutout" || type === "mc_shoutout";
  const target = sprayTargets.find((t) => choiceKey(t) === sprayChoice) ?? null;

  function choose(next: OrderType) {
    // The nickname field appears now; prefill it from last time.
    if (!nickname) {
      try {
        const saved = localStorage.getItem(NICKNAME_KEY);
        if (saved) setNickname(saved);
      } catch {
        // Storage unavailable (private mode); the field just starts empty.
      }
    }
    setType(next);
    setPreset(null);
    setCustom("");
    setErrors({});
  }

  function validate(): Errors {
    const e: Errors = {};
    const filtered = (text: string) => {
      const result = checkText(text);
      return result.ok ? undefined : FILTER_MESSAGES[result.reason];
    };

    if (!nickname.trim()) e.nickname = "Add a nickname so they know who it's from";
    else e.nickname = filtered(nickname);

    if (type === "spray" && !sprayChoice) e.sprayTarget = "Who are you spraying?";
    if (needsMessage) {
      if (!message.trim()) e.message = "Write your shoutout";
      else e.message = filtered(message);
    }
    if (type === "song_request" && !songTitle.trim()) e.songTitle = "Which song?";

    if (!amount) e.amount = custom ? "Enter a whole naira amount" : "Choose an amount";
    else if (minAmount && toMinorUnits(amount) < toMinorUnits(minAmount)) {
      e.amount = `The minimum is ${formatNaira(minAmount)}`;
    }

    return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!type || submitting) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      localStorage.setItem(NICKNAME_KEY, nickname.trim());
    } catch {
      // Not important enough to block payment.
    }

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venueSlug,
          type,
          nickname: nickname.trim(),
          amount,
          tableLabel: tableLabel ?? undefined,
          message: needsMessage ? message.trim() : undefined,
          songTitle: type === "song_request" ? songTitle.trim() : undefined,
          songArtist: type === "song_request" && songArtist.trim() ? songArtist.trim() : undefined,
          sprayTarget: type === "spray" && target ? { role: target.role, profileId: target.profileId } : undefined,
          showOnLeaderboard,
        }),
      });
      const body = await res.json().catch(() => null);

      if (res.ok && body?.checkoutUrl) {
        window.location.assign(body.checkoutUrl);
        return; // keep the button disabled while the browser navigates
      }
      setErrors(errorsFromResponse(res.status, body));
    } catch {
      setErrors({ form: "Couldn't reach us. Check your signal and try again." });
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-8">
      <fieldset>
        <legend className="mb-3 text-lg font-semibold">What do you want to do?</legend>
        <div className="grid grid-cols-2 gap-3">
          {options.map((o) => {
            const info = TYPES[o.type];
            const selected = o.type === type;
            return (
              <button
                key={o.type}
                type="button"
                disabled={!o.enabled}
                aria-pressed={selected}
                onClick={() => choose(o.type)}
                className={`flex min-h-32 flex-col items-start rounded-2xl border p-4 text-left transition active:scale-[0.98] disabled:opacity-40 ${
                  selected ? "border-amber-400 bg-amber-400/10" : "border-neutral-800 bg-neutral-900"
                }`}
              >
                <span className="text-2xl" aria-hidden>
                  {info.emoji}
                </span>
                <span className="mt-2 font-semibold">{info.title}</span>
                <span className="mt-1 text-xs text-neutral-400">
                  {o.enabled ? `From ${formatNaira(o.minAmount)}` : "Paused"}
                </span>
              </button>
            );
          })}
        </div>
        {type && <p className="mt-3 text-sm text-neutral-400">{TYPES[type].blurb}</p>}
      </fieldset>

      {type === "spray" && (
        <fieldset>
          <legend className="mb-3 text-lg font-semibold">Spray who?</legend>
          <div className="grid grid-cols-2 gap-2">
            <Chip selected={sprayChoice === "everyone"} onClick={() => setSprayChoice("everyone")}>
              Everyone 🔥
            </Chip>
            {sprayTargets.map((t) => (
              <Chip
                key={choiceKey(t)}
                selected={sprayChoice === choiceKey(t)}
                onClick={() => setSprayChoice(choiceKey(t))}
              >
                <span className="block truncate px-2">{t.name}</span>
                <span className="block text-xs font-normal text-neutral-400">
                  {ROLE_LABELS[t.role]}
                  {t.onNow && " · on now"}
                </span>
              </Chip>
            ))}
          </div>
          <FieldError message={errors.sprayTarget} />
        </fieldset>
      )}

      {needsMessage && (
        <Field label="Your shoutout" error={errors.message}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MAX_MESSAGE}
            rows={3}
            placeholder="e.g. Happy birthday Tolu! Table 7 loves you 🎉"
            className={`${inputClass} resize-none`}
          />
          <p className="mt-1 text-right text-xs text-neutral-500">
            {message.length}/{MAX_MESSAGE}
          </p>
          {type === "screen_shoutout" && (
            <p className="mt-1 text-xs text-neutral-500">Staff approve shoutouts before they go on screen.</p>
          )}
        </Field>
      )}

      {type === "song_request" && (
        <div className="flex flex-col gap-4">
          <Field label="Song" error={errors.songTitle}>
            <input
              value={songTitle}
              onChange={(e) => setSongTitle(e.target.value)}
              maxLength={120}
              placeholder="e.g. Ojuelegba"
              className={inputClass}
            />
          </Field>
          <Field label="Artist (optional)">
            <input
              value={songArtist}
              onChange={(e) => setSongArtist(e.target.value)}
              maxLength={120}
              placeholder="e.g. Wizkid"
              className={inputClass}
            />
          </Field>
          <p className="text-sm text-neutral-400">
            Not played within {requestTimeoutMinutes} minutes? You&apos;re refunded automatically.
          </p>
        </div>
      )}

      {type && minAmount && (
        <fieldset>
          <legend className="mb-3 text-lg font-semibold">How much?</legend>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((p) => (
              <Chip
                key={p}
                selected={!custom && preset === p}
                onClick={() => {
                  setPreset(p);
                  setCustom("");
                }}
              >
                {formatNaira(p)}
              </Chip>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 px-4 focus-within:border-amber-400">
            <span className="text-neutral-400">₦</span>
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="Other amount"
              aria-label="Other amount in naira"
              className="h-14 w-full bg-transparent text-lg outline-none"
            />
          </label>
          <FieldError message={errors.amount} />
        </fieldset>
      )}

      {type && (
        <div className="flex flex-col gap-3">
          <Field label="Your nickname" error={errors.nickname}>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={30}
              autoComplete="nickname"
              placeholder="e.g. Big Tunde"
              className={inputClass}
            />
          </Field>
          <label className="flex min-h-12 items-center gap-3 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={showOnLeaderboard}
              onChange={(e) => setShowOnLeaderboard(e.target.checked)}
              className="size-5 accent-amber-400"
            />
            Show my nickname on the leaderboard
          </label>
        </div>
      )}

      {type && (
        <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-background via-background to-transparent px-4 pt-6 pb-4">
          <FieldError message={errors.form} />
          <button
            type="submit"
            disabled={submitting}
            className="h-14 w-full rounded-2xl bg-amber-400 text-lg font-bold text-black transition active:scale-[0.99] disabled:opacity-60"
          >
            {submitting ? "Opening payment…" : amount ? `Pay ${formatNaira(amount)}` : "Pay"}
          </button>
          <p className="mt-2 text-center text-xs text-neutral-500">
            Secure payment by Bachs. A small processing fee is added at checkout.
          </p>
        </div>
      )}
    </form>
  );
}

const inputClass =
  "h-14 w-full rounded-xl border border-neutral-800 bg-neutral-900 px-4 text-lg outline-none placeholder:text-neutral-600 focus:border-amber-400";

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block font-semibold">{label}</span>
      {children}
      <FieldError message={error} />
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-red-400">
      {message}
    </p>
  );
}

function Chip({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-14 rounded-xl border py-2 font-semibold transition active:scale-[0.98] ${
        selected ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-neutral-800 bg-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}

// Four sensible amounts starting at the venue's minimum.
function presetsFor(minAmount: string): string[] {
  const min = toMinorUnits(minAmount);
  const ladder = PRESET_LADDER.map((n) => `${n}.00`).filter((a) => toMinorUnits(a) > min);
  return [minAmount, ...ladder].slice(0, 4);
}

function errorsFromResponse(status: number, body: unknown): Errors {
  const data = (body ?? {}) as { error?: string; issues?: Record<string, string[] | undefined> };
  if (status === 400 && data.issues) {
    const e: Errors = {};
    for (const [field, messages] of Object.entries(data.issues)) {
      const key = (["nickname", "message", "songTitle", "amount", "sprayTarget"] as const).find((f) => f === field);
      if (key && messages?.[0]) e[key] = messages[0];
    }
    return Object.keys(e).length > 0 ? e : { form: "Please check your details and try again." };
  }
  if (status === 422) {
    return { form: "This isn't available right now. Prices may have changed: refresh and try again." };
  }
  if (status === 404) return { form: "We can't find this venue. Scan the QR code again." };
  return { form: "Payment is unavailable right now. Please try again in a moment." };
}

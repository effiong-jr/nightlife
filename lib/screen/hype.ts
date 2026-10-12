import { formatNairaShort, toMinorUnits } from "@/lib/money";

// Copy for the club screen and MC alerts: hype-man energy, Nigerian flavour,
// never cheesy or offensive. Lines are picked deterministically from the
// order ID so a screen reload shows the same line.

export type ScreenSpray = {
  id: string;
  name: string; // already "A big spender" when the attendee opted out
  table: string | null;
  amount: string;
  // Targeted sprays name a DJ or MC; untargeted sprays have neither.
  target: "dj" | "mc" | null;
  targetName: string | null;
};

const HEADLINES = [
  "{who} don scatter the place!",
  "Owo ti de! {who} is spraying!",
  "{who} no dey look price!",
  "Make way! {who} don land!",
  "Ehen! {who} has entered the building!",
];

const BIG_HEADLINES = [
  "Who send you?! {who} just shut it down!",
  "{who} wan finish the money tonight!",
  "Na {who} get this place tonight!",
];

const BIG_SPRAY = toMinorUnits("50000.00");

function pick<T>(items: T[], seed: string): T {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return items[Math.abs(hash) % items.length];
}

export function isBigSpray(amount: string): boolean {
  return toMinorUnits(amount) >= BIG_SPRAY;
}

export function sprayHeadline(spray: ScreenSpray): string {
  const who = spray.table ?? spray.name;
  const lines = isBigSpray(spray.amount) ? BIG_HEADLINES : HEADLINES;
  return pick(lines, spray.id).replace("{who}", who);
}

// "₦50k spray for DJ Spinall!" / "₦50k spray!"
export function spraySubline(spray: ScreenSpray): string {
  const amount = `${formatNairaShort(spray.amount)} spray`;
  if (spray.targetName) return `${amount} for ${spray.targetName}!`;
  if (spray.target === "dj") return `${amount} for the DJ!`;
  if (spray.target === "mc") return `${amount} for the hype man!`;
  return `${amount}!`;
}

// Who sent it, when the headline used the table: "Big Tunde, Table 7".
export function sprayByline(spray: ScreenSpray): string | null {
  if (!spray.table) return null;
  return spray.name === "A big spender" ? spray.table : `${spray.name}, ${spray.table}`;
}

// First-pass filter for nicknames and shoutouts. Runs in the browser (instant
// feedback) and on the server (authoritative). Human approval still follows for
// anything shown on screen or read on the mic, so this aims to catch the obvious
// without blocking innocent words ("class", "Scunthorpe").
//
// The lists are a starting point: review them with the pilot club.

// Matched anywhere in the letters-only text, even inside other words.
// Keep this list to stems that never occur inside innocent words.
const ALWAYS_BLOCKED = ["fuck", "fuk", "nigger", "nigga", "motherfuck"];

// Matched as whole words only (after normalising).
const BLOCKED_WORDS = [
  // English
  "shit", "bullshit", "bitch", "bitches", "cunt", "ass", "asshole", "arse", "dick", "dickhead", "pussy",
  "bastard", "slut", "whore", "hoe", "cock", "prick", "twat", "wanker", "retard", "retarded",
  "fag", "faggot", "rape", "rapist", "porn", "sex",
  // Nigerian insults and ethnic slurs
  "ashawo", "ashewo", "olosho", "oloshi", "oloriburuku", "omoale", "nyamiri", "gambari",
];

// Multi-word phrases, matched on the words joined together.
const BLOCKED_PHRASES = ["omo ale", "son of a bitch"];

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i",
};

export type FilterResult = { ok: true } | { ok: false; reason: "language" | "contact" };

function words(text: string): string[] {
  const mapped = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c] ?? c);
  return mapped.split(/[^a-z]+/).filter(Boolean);
}

// "fuuuuck" -> "fuck"; also used on list entries so both sides match.
const squeeze = (word: string) => word.replace(/(.)\1+/g, "$1");

const blockedWordSet = new Set(BLOCKED_WORDS.map(squeeze));
const alwaysBlocked = ALWAYS_BLOCKED.map(squeeze);
const blockedPhrases = BLOCKED_PHRASES.map((p) => squeeze(p.replace(/\s+/g, "")));

// Phone numbers and links: shoutouts are public, so no contact details.
const CONTACT_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ng|net|org|io|co)\b|@[a-z0-9_]{3,}|(\d[\s.-]?){7,})/i;

export function checkText(text: string): FilterResult {
  if (CONTACT_RE.test(text)) return { ok: false, reason: "contact" };

  const tokens = words(text);
  const squeezed = tokens.map(squeeze);
  if (squeezed.some((w) => blockedWordSet.has(w))) return { ok: false, reason: "language" };

  // Joined text catches "f u c k", "f.u.c.k" and phrases.
  const joined = squeeze(tokens.join(""));
  if (alwaysBlocked.some((w) => joined.includes(w))) return { ok: false, reason: "language" };
  if (blockedPhrases.some((p) => joined.includes(p))) return { ok: false, reason: "language" };

  // Spelled out with separators between single letters, e.g. "s h i t".
  const singles = squeeze(
    tokens
      .map((t) => (t.length === 1 ? t : " "))
      .join("")
      .replace(/\s+/g, " "),
  );
  if (singles.split(" ").some((w) => w.length > 1 && blockedWordSet.has(w))) {
    return { ok: false, reason: "language" };
  }

  return { ok: true };
}

export const FILTER_MESSAGES: Record<"language" | "contact", string> = {
  language: "Keep it clean, please. Try different words.",
  contact: "No phone numbers, handles or links, please.",
};

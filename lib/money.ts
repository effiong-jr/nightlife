// Money is a decimal string with exactly 2 places plus an ISO currency, matching
// the Bachs API and Postgres numeric(14,2). Never a float. Arithmetic, if ever
// needed, goes through minor units as bigint.

export type Money = { amount: string; currency: string };

// numeric(14,2): up to 12 integer digits.
export const AMOUNT_RE = /^(0|[1-9]\d{0,11})\.\d{2}$/;

export function isAmount(value: string): boolean {
  return AMOUNT_RE.test(value);
}

export function toMinorUnits(amount: string): bigint {
  if (!isAmount(amount)) throw new Error(`Invalid amount: ${amount}`);
  return BigInt(amount.replace(".", ""));
}

export function fromMinorUnits(minor: bigint): string {
  if (minor < 0n) throw new Error("Negative amounts are not supported");
  const s = minor.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function amountsEqual(a: string, b: string): boolean {
  return toMinorUnits(a) === toMinorUnits(b);
}

// Whole naira from a number input ("5000") to an amount string ("5000.00").
export function nairaToAmount(naira: string): string | null {
  const trimmed = naira.trim();
  return /^[1-9]\d{0,11}$/.test(trimmed) ? `${trimmed}.00` : null;
}

// "₦2,000" / "₦2,000.50". Formats from the string, never via a float.
export function formatNaira(amount: string): string {
  const [whole, kobo] = fromMinorUnits(toMinorUnits(amount)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return kobo === "00" ? `₦${grouped}` : `₦${grouped}.${kobo}`;
}

import { z } from "zod";

// Money is a decimal string with exactly 2 places plus an ISO currency, matching
// the Bachs API and Postgres numeric(14,2). Never a float. Arithmetic, if ever
// needed, goes through minor units as bigint.

export type Money = { amount: string; currency: string };

// numeric(14,2): up to 12 integer digits.
const AMOUNT_RE = /^(0|[1-9]\d{0,11})\.\d{2}$/;

export const amountSchema = z
  .string()
  .regex(AMOUNT_RE, "Amount must be a decimal string with 2 places, e.g. \"2000.00\"");

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 code");

export const moneySchema = z.object({ amount: amountSchema, currency: currencySchema });

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

// "₦2,000" / "₦2,000.50". Formats from the string, never via a float.
export function formatNaira(amount: string): string {
  const [whole, kobo] = fromMinorUnits(toMinorUnits(amount)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return kobo === "00" ? `₦${grouped}` : `₦${grouped}.${kobo}`;
}

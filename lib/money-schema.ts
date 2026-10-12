import { z } from "zod";
import { AMOUNT_RE } from "./money";

// Zod schemas for money, kept apart from lib/money.ts so client bundles that
// only format amounts don't pull in Zod.

export const amountSchema = z
  .string()
  .regex(AMOUNT_RE, 'Amount must be a decimal string with 2 places, e.g. "2000.00"');

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 code");

export const moneySchema = z.object({ amount: amountSchema, currency: currencySchema });

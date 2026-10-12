import "server-only";
import { z } from "zod";

// Server-only environment. Grouped so each subsystem validates just what it needs:
// e.g. the Supabase admin client works before Bachs keys exist.
// Public (NEXT_PUBLIC_*) vars live in lib/supabase/env.ts.

type Source = Record<string, string | undefined>;

const supabaseSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
});

const bachsSchema = z.object({
  // Rule 9: sandbox keys only until we're told to go live.
  BACHS_SECRET_KEY: z
    .string()
    .startsWith("sk_sandbox_", "BACHS_SECRET_KEY must be a sandbox key (sk_sandbox_...)"),
  // Optional until a webhook destination exists (`bachs listen` prints one locally).
  // The webhook route refuses every request while it's unset.
  // An empty value (as copied from .env.example) counts as unset.
  BACHS_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => value || undefined),
});

const appSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be at least 32 characters"),
});

function parse<T extends z.ZodType>(schema: T, name: string, source: Source): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ${name} environment variables:\n${issues}`);
  }
  return result.data;
}

export function supabaseServerEnv(source: Source = process.env) {
  return parse(supabaseSchema, "Supabase", source);
}

export function bachsEnv(source: Source = process.env) {
  return parse(bachsSchema, "Bachs", source);
}

export function appEnv(source: Source = process.env) {
  return parse(appSchema, "app", source);
}

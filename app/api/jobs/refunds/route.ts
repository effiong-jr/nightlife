import { timingSafeEqual } from "node:crypto";
import { getPaymentProvider } from "@/lib/payments";
import { appEnv } from "@/lib/server/env";
import { processDueRefunds } from "@/lib/server/refunds";
import { createAdminClient } from "@/lib/supabase/admin";

// Refund worker. Called every minute by pg_cron (public.kick_refund_worker)
// with Authorization: Bearer <CRON_SECRET>.
export async function POST(request: Request) {
  if (!authorized(request.headers.get("authorization"), appEnv().CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await processDueRefunds({ admin: createAdminClient(), provider: getPaymentProvider() });
  return Response.json(result);
}

function authorized(header: string | null, secret: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

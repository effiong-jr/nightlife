import "server-only";
import { createClient } from "@supabase/supabase-js";
import { supabaseServerEnv } from "@/lib/server/env";
import { supabasePublicEnv } from "./env";

// Secret-key client that BYPASSES RLS. Only for trusted server paths
// (payment webhooks, cron jobs, admin actions). Never import from client code.
export function createAdminClient() {
  const { url } = supabasePublicEnv();
  const { SUPABASE_SECRET_KEY } = supabaseServerEnv();
  return createClient(url, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

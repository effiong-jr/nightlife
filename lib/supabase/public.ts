import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { supabasePublicEnv } from "./env";

// Anonymous client with no session or cookies, for public data (venue pages).
// Same permissions as an attendee: RLS applies.
export function createPublicClient() {
  const { url, publishableKey } = supabasePublicEnv();
  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

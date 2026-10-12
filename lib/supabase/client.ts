import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { supabasePublicEnv } from "./env";

// Browser client: publishable key, subject to RLS.
export function createClient() {
  const { url, publishableKey } = supabasePublicEnv();
  return createBrowserClient<Database>(url, publishableKey);
}

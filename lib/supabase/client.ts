import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { supabasePublicEnv } from "./env";

type BrowserClient = ReturnType<typeof createBrowserClient<Database>>;
let client: BrowserClient | null = null;

// Browser client: publishable key + the signed-in staff session, subject to RLS.
// Call it only from effects and event handlers, never during render: creating
// the auth client reads the clock, which Next.js forbids while prerendering.
export function getBrowserClient(): BrowserClient {
  if (!client) {
    const { url, publishableKey } = supabasePublicEnv();
    client = createBrowserClient<Database>(url, publishableKey);
  }
  return client;
}

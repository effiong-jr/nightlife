import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";
import { supabasePublicEnv } from "./env";

// Server Component / Route Handler / Server Action client: acts as the signed-in
// staff user (or anonymous), subject to RLS.
export async function createClient() {
  const { url, publishableKey } = supabasePublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Session refresh will be handled in proxy.ts when staff auth lands.
        }
      },
    },
  });
}

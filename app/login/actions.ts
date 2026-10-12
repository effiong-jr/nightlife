"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type SignInState = { error: string | null };

const credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

// Only same-site paths, never "//evil.com" or absolute URLs.
function safeNext(next: string | undefined): string {
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/club";
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "That email and password don't match." };

  redirect(safeNext(parsed.data.next));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

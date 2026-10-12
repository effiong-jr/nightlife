"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { normalizeNigerianPhone } from "@/lib/phone";
import { staffHomePath } from "@/lib/server/staff";
import { createClient } from "@/lib/supabase/server";

// Only same-site paths, never "//evil.com" or absolute URLs.
function safeNext(next: unknown): string | null {
  return typeof next === "string" && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : null;
}

// Phone OTP sign-in (staff). Step 1 sends a code, step 2 verifies it.
// New accounts are only created from an invite link (allowSignUp), never from
// the plain login page.
export type PhoneSignInState = {
  step: "phone" | "code";
  phone: string | null;
  error: string | null;
};

const codeSchema = z.string().trim().regex(/^\d{6}$/);

export async function phoneSignIn(prev: PhoneSignInState, formData: FormData): Promise<PhoneSignInState> {
  const supabase = await createClient();
  const next = safeNext(formData.get("next"));
  const allowSignUp = formData.get("allowSignUp") === "1" && next?.startsWith("/join/") === true;

  if (prev.step === "phone" || formData.get("intent") === "resend") {
    const phone = normalizeNigerianPhone(String(formData.get("phone") ?? prev.phone ?? ""));
    if (!phone) return { step: "phone", phone: null, error: "Enter a Nigerian mobile number, e.g. 0803 123 4567." };

    const { error } = await supabase.auth.signInWithOtp({ phone, options: { shouldCreateUser: allowSignUp } });
    if (error) {
      const message =
        error.code === "otp_disabled" || error.code === "user_not_found" || /signups not allowed/i.test(error.message)
          ? "No staff account uses this number. Ask your club for an invite link."
          : error.status === 429 || /security purposes|rate/i.test(error.message)
            ? "Wait a few seconds, then try again."
            : "Couldn't send the code. Try again.";
      return { step: "phone", phone: null, error: message };
    }
    return { step: "code", phone, error: null };
  }

  const code = codeSchema.safeParse(formData.get("code"));
  if (!prev.phone || !code.success) return { ...prev, error: "Enter the 6-digit code." };
  const { error } = await supabase.auth.verifyOtp({ phone: prev.phone, token: code.data, type: "sms" });
  if (error) return { ...prev, error: "That code is wrong or has expired." };

  redirect(next ?? (await staffHomePath()));
}

// Email + password: kept for the seeded test accounts.
export type SignInState = { error: string | null };

const credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = credentials.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "That email and password don't match." };

  redirect(safeNext(parsed.data.next) ?? (await staffHomePath()));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { smsEnv } from "./env";

// Phone OTPs for staff sign-in. Supabase Auth calls our Send SMS hook
// (app/api/auth/send-sms) with the code; we deliver it through Termii.

const SIGNATURE_TOLERANCE_SECONDS = 300;

export class HookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookSignatureError";
  }
}

// Supabase auth hooks are signed per Standard Webhooks:
// webhook-signature: "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>"
// (space-separated when there are several), secret "v1,whsec_<base64 key>".
export function verifyAuthHook(rawBody: string, headers: Headers, secret: string, nowMs = Date.now()): void {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) {
    throw new HookSignatureError("Missing webhook headers");
  }
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new HookSignatureError("Webhook timestamp outside tolerance");
  }

  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"));
  const valid = signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) return false;
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new HookSignatureError("Webhook signature mismatch");
}

// Builds headers for a signed hook request. Used by tests.
export function signAuthHook(rawBody: string, secret: string, id: string, timestampSeconds: number): Headers {
  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestampSeconds}.${rawBody}`).digest("base64");
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": `v1,${signature}`,
  });
}

export const sendSmsHookSchema = z.object({
  user: z.object({ phone: z.string().min(1) }),
  sms: z.object({ otp: z.string().regex(/^\d{4,10}$/) }),
});

export function otpMessage(otp: string): string {
  return `Your Nightlife code is ${otp}. Don't share it with anyone.`;
}

// Sends through Termii's DND route (required for OTPs to Nigerian numbers).
// Without Termii configured, development logs the code instead of sending.
export async function sendOtpSms(phone: string, otp: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const env = smsEnv();
  const to = phone.replace(/^\+/, "");

  if (!env.TERMII_API_KEY || !env.TERMII_SENDER_ID) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Termii is not configured (TERMII_API_KEY / TERMII_SENDER_ID)");
    }
    console.info(`[dev sms] OTP for +${to}: ${otp}`);
    return;
  }

  const res = await fetchImpl(`${env.TERMII_BASE_URL}/api/sms/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TERMII_API_KEY,
      to,
      from: env.TERMII_SENDER_ID,
      sms: otpMessage(otp),
      type: "plain",
      channel: "dnd",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Termii send failed with ${res.status}`);
  }
}

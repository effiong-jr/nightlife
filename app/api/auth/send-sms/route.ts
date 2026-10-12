import { smsEnv } from "@/lib/server/env";
import { HookSignatureError, sendOtpSms, sendSmsHookSchema, verifyAuthHook } from "@/lib/server/sms";

// Supabase Auth "Send SMS" hook: delivers staff sign-in codes via Termii.
// Errors use the hook's { error: { http_code, message } } shape.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const fail = (status: number, message: string) =>
    Response.json({ error: { http_code: status, message } }, { status });

  try {
    verifyAuthHook(rawBody, request.headers, smsEnv().SEND_SMS_HOOK_SECRET);
  } catch (err) {
    if (err instanceof HookSignatureError) return fail(401, "Invalid signature");
    throw err;
  }

  const payload = sendSmsHookSchema.safeParse(JSON.parse(rawBody));
  if (!payload.success) return fail(400, "Unexpected payload");

  try {
    await sendOtpSms(payload.data.user.phone, payload.data.sms.otp);
  } catch (err) {
    console.error("OTP SMS failed", err);
    return fail(502, "Couldn't send the code. Try again.");
  }
  return Response.json({});
}

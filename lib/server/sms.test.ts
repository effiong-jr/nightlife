import { describe, expect, it, vi } from "vitest";
import { HookSignatureError, otpMessage, sendOtpSms, signAuthHook, verifyAuthHook } from "./sms";

const SECRET = `v1,whsec_${Buffer.from("test-hook-secret-32-bytes-long!!").toString("base64")}`;
const NOW = 1_760_000_000;
const body = JSON.stringify({ user: { phone: "2348031234567" }, sms: { otp: "123456" } });

describe("verifyAuthHook", () => {
  it("accepts a correctly signed request", () => {
    expect(() => verifyAuthHook(body, signAuthHook(body, SECRET, "msg_1", NOW), SECRET, NOW * 1000)).not.toThrow();
  });

  it("accepts any of several signatures (secret rotation)", () => {
    const headers = signAuthHook(body, SECRET, "msg_1", NOW);
    headers.set("webhook-signature", `v1,bogus ${headers.get("webhook-signature")}`);
    expect(() => verifyAuthHook(body, headers, SECRET, NOW * 1000)).not.toThrow();
  });

  it.each([
    ["a tampered body", () => [body.replace("123456", "000000"), signAuthHook(body, SECRET, "msg_1", NOW)] as const],
    ["another secret", () => [body, signAuthHook(body, `v1,whsec_${Buffer.from("other").toString("base64")}`, "msg_1", NOW)] as const],
    ["a stale timestamp", () => [body, signAuthHook(body, SECRET, "msg_1", NOW - 301)] as const],
    ["no headers", () => [body, new Headers()] as const],
  ])("rejects %s", (_, make) => {
    const [rawBody, headers] = make();
    expect(() => verifyAuthHook(rawBody, headers, SECRET, NOW * 1000)).toThrow(HookSignatureError);
  });
});

describe("sendOtpSms", () => {
  it("sends through Termii's DND channel without the +", async () => {
    vi.stubEnv("SEND_SMS_HOOK_SECRET", SECRET);
    vi.stubEnv("TERMII_API_KEY", "tk_test");
    vi.stubEnv("TERMII_SENDER_ID", "Nightlife");
    vi.stubEnv("TERMII_BASE_URL", "https://example.termii.test");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "ok" }));

    await sendOtpSms("+2348031234567", "123456", fetchMock);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.termii.test/api/sms/send");
    expect(JSON.parse(init?.body as string)).toEqual({
      api_key: "tk_test",
      to: "2348031234567",
      from: "Nightlife",
      sms: otpMessage("123456"),
      type: "plain",
      channel: "dnd",
    });
    vi.unstubAllEnvs();
  });

  it("refuses to run unconfigured in production", async () => {
    vi.stubEnv("SEND_SMS_HOOK_SECRET", SECRET);
    vi.stubEnv("TERMII_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendOtpSms("+2348031234567", "123456")).rejects.toThrow(/not configured/);
    vi.unstubAllEnvs();
  });
});

import { describe, expect, it } from "vitest";
import { appEnv, bachsEnv, supabaseServerEnv } from "./env";

describe("server env", () => {
  it("accepts a Bachs sandbox key", () => {
    const env = bachsEnv({
      BACHS_SECRET_KEY: "sk_sandbox_abc123",
      BACHS_WEBHOOK_SECRET: "whsec_test",
    });
    expect(env.BACHS_SECRET_KEY).toBe("sk_sandbox_abc123");
  });

  it("rejects a non-sandbox Bachs key", () => {
    expect(() =>
      bachsEnv({ BACHS_SECRET_KEY: "sk_live_abc123", BACHS_WEBHOOK_SECRET: "whsec_test" }),
    ).toThrow(/sandbox key/);
  });

  it("reports every missing variable", () => {
    expect(() => bachsEnv({})).toThrow(/BACHS_SECRET_KEY/);
    expect(bachsEnv({ BACHS_SECRET_KEY: "sk_sandbox_x" }).BACHS_WEBHOOK_SECRET).toBeUndefined();
    expect(
      bachsEnv({ BACHS_SECRET_KEY: "sk_sandbox_x", BACHS_WEBHOOK_SECRET: "" }).BACHS_WEBHOOK_SECRET,
    ).toBeUndefined();
    expect(() => supabaseServerEnv({})).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it("requires a long CRON_SECRET and a valid NEXT_PUBLIC_APP_URL", () => {
    expect(() => appEnv({ NEXT_PUBLIC_APP_URL: "not a url", CRON_SECRET: "short" })).toThrow(
      /NEXT_PUBLIC_APP_URL[\s\S]*CRON_SECRET/,
    );
    expect(
      appEnv({ NEXT_PUBLIC_APP_URL: "http://localhost:3000", CRON_SECRET: "x".repeat(32) }).NEXT_PUBLIC_APP_URL,
    ).toBe("http://localhost:3000");
  });
});

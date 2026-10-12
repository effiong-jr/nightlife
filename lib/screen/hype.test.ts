import { describe, expect, it } from "vitest";
import { type ScreenSpray, isBigSpray, sprayByline, sprayHeadline, spraySubline } from "./hype";

const spray = (overrides: Partial<ScreenSpray> = {}): ScreenSpray => ({
  id: "6f1b0c4e-8a5d-4f8e-9b7a-2c3d4e5f6a7b",
  name: "Big Tunde",
  table: "Table 7",
  amount: "20000.00",
  target: "dj",
  targetName: "DJ Spinall",
  ...overrides,
});

describe("screen hype copy", () => {
  it("leads with the table when there is one, else the nickname", () => {
    expect(sprayHeadline(spray())).toContain("Table 7");
    expect(sprayHeadline(spray({ table: null }))).toContain("Big Tunde");
  });

  it("is stable for the same order", () => {
    expect(sprayHeadline(spray())).toBe(sprayHeadline(spray()));
  });

  it("names the target with a compact amount", () => {
    expect(spraySubline(spray())).toBe("₦20k spray for DJ Spinall!");
    expect(spraySubline(spray({ target: "mc", targetName: "MC Tolu", amount: "1500.00" }))).toBe(
      "₦1.5k spray for MC Tolu!",
    );
    expect(spraySubline(spray({ target: "mc", targetName: null }))).toBe("₦20k spray for the hype man!");
    expect(spraySubline(spray({ target: null, targetName: null }))).toBe("₦20k spray!");
  });

  it("never pairs an opted-out nickname with the amount", () => {
    const anon = spray({ name: "A big spender" });
    expect(sprayByline(anon)).toBe("Table 7");
    expect(sprayByline(spray())).toBe("Big Tunde, Table 7");
    expect(sprayByline(spray({ table: null }))).toBeNull();
  });

  it("uses bigger lines from ₦50k", () => {
    expect(isBigSpray("49999.99")).toBe(false);
    expect(isBigSpray("50000.00")).toBe(true);
  });
});

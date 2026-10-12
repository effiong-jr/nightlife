import { describe, expect, it } from "vitest";
import { businessDayStart, parsePeriod, percentOf, periodRange } from "./admin-stats";

describe("admin stats periods", () => {
  it("'tonight' starts at 06:00 Lagos (05:00 UTC), even after midnight", () => {
    expect(businessDayStart(new Date("2026-10-12T21:00:00Z")).toISOString()).toBe("2026-10-12T05:00:00.000Z"); // 22:00 Lagos
    expect(businessDayStart(new Date("2026-10-13T02:30:00Z")).toISOString()).toBe("2026-10-12T05:00:00.000Z"); // 03:30 Lagos
    expect(businessDayStart(new Date("2026-10-13T06:00:00Z")).toISOString()).toBe("2026-10-13T05:00:00.000Z"); // 07:00 Lagos
  });

  it("resolves ranges and falls back to 7 days", () => {
    const now = new Date("2026-10-12T12:00:00Z");
    expect(periodRange("7d", now).from.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(periodRange("all", now).from.getTime()).toBe(0);
    expect(parsePeriod("30d")).toBe("30d");
    expect(parsePeriod("nonsense")).toBe("7d");
  });

  it("computes percentages from money strings exactly", () => {
    expect(percentOf("15000.00", "371500.00")).toBe("4.0%");
    expect(percentOf("1.00", "3.00")).toBe("33.3%");
    expect(percentOf("5.00", "0.00")).toBe("0%");
  });
});

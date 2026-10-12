import { describe, expect, it } from "vitest";
import { retryDelayMinutes } from "./refunds";

describe("retryDelayMinutes", () => {
  it("backs off exponentially, capped at an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelayMinutes)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });
});

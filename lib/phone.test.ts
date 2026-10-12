import { describe, expect, it } from "vitest";
import { formatNigerianPhone, normalizeNigerianPhone } from "./phone";

describe("normalizeNigerianPhone", () => {
  it.each([
    ["08031234567", "+2348031234567"],
    ["0803 123 4567", "+2348031234567"],
    ["803-123-4567", "+2348031234567"],
    ["+234 803 123 4567", "+2348031234567"],
    ["2348031234567", "+2348031234567"],
    ["(0701) 234 5678", "+2347012345678"],
    ["09012345678", "+2349012345678"],
    ["08000000099", "+2348000000099"], // local test number
  ])("%s -> %s", (input, expected) => {
    expect(normalizeNigerianPhone(input)).toBe(expected);
  });

  it.each(["", "12345", "0803123456", "080312345678", "+447911123456", "06031234567", "0803123456a"])(
    "rejects %s",
    (input) => {
      expect(normalizeNigerianPhone(input)).toBeNull();
    },
  );
});

describe("formatNigerianPhone", () => {
  it("formats for display", () => {
    expect(formatNigerianPhone("+2348031234567")).toBe("0803 123 4567");
    expect(formatNigerianPhone("2348031234567")).toBe("0803 123 4567");
  });
});

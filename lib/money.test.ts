import { describe, expect, it } from "vitest";
import {
  amountsEqual,
  formatNaira,
  formatNairaShort,
  fromMinorUnits,
  isAmount,
  nairaToAmount,
  toMinorUnits,
} from "./money";

describe("money", () => {
  it("accepts only 2-decimal strings that fit numeric(14,2)", () => {
    for (const ok of ["0.01", "2000.00", "999999999999.99"]) expect(isAmount(ok)).toBe(true);
    for (const bad of ["2000", "2000.0", "2000.000", "-1.00", "01.00", "1e3", "1,000.00", " 1.00", "1000000000000.00"]) {
      expect(isAmount(bad)).toBe(false);
    }
  });

  it("round-trips through minor units without floats", () => {
    expect(toMinorUnits("2000.00")).toBe(200000n);
    expect(toMinorUnits("0.07")).toBe(7n);
    expect(fromMinorUnits(7n)).toBe("0.07");
    expect(fromMinorUnits(toMinorUnits("999999999999.99"))).toBe("999999999999.99");
    expect(amountsEqual("75000.00", "75000.00")).toBe(true);
    expect(amountsEqual("75000.00", "75000.01")).toBe(false);
  });

  it("converts whole-naira input to an amount", () => {
    expect(nairaToAmount("5000")).toBe("5000.00");
    expect(nairaToAmount(" 250 ")).toBe("250.00");
    for (const bad of ["", "0", "05", "5.5", "-5", "5,000", "1e4"]) expect(nairaToAmount(bad)).toBeNull();
  });

  it("formats compact screen amounts, rounding down", () => {
    expect(formatNairaShort("999.99")).toBe("₦999");
    expect(formatNairaShort("1000.00")).toBe("₦1k");
    expect(formatNairaShort("1500.00")).toBe("₦1.5k");
    expect(formatNairaShort("1999.00")).toBe("₦1.9k");
    expect(formatNairaShort("50000.00")).toBe("₦50k");
    expect(formatNairaShort("125500.00")).toBe("₦125k");
    expect(formatNairaShort("2500000.00")).toBe("₦2.5m");
  });

  it("formats naira with thousands separators", () => {
    expect(formatNaira("50000.00")).toBe("₦50,000");
    expect(formatNaira("1234567.50")).toBe("₦1,234,567.50");
    expect(formatNaira("999.00")).toBe("₦999");
    expect(formatNaira("0.05")).toBe("₦0.05");
  });
});

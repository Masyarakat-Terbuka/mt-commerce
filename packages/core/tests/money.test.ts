import { describe, expect, it } from "vitest";
import {
  abs,
  add,
  compare,
  equals,
  format,
  fromJSON,
  isMoney,
  isNegative,
  isPositive,
  isZero,
  multiply,
  negate,
  subtract,
  toJSON,
  zero,
  type Money,
} from "../src/money.js";
import { CurrencyMismatchError } from "../src/errors.js";

const idr = (amount: bigint): Money => ({ amount, currency: "IDR" });
const usd = (amount: bigint): Money => ({ amount, currency: "USD" });

describe("zero", () => {
  it("returns 0n with the requested currency", () => {
    expect(zero("IDR")).toEqual({ amount: 0n, currency: "IDR" });
    expect(zero("USD")).toEqual({ amount: 0n, currency: "USD" });
  });
});

describe("isMoney", () => {
  it("recognizes a well-formed Money", () => {
    expect(isMoney(idr(100n))).toBe(true);
  });
  it("rejects null, undefined, and non-objects", () => {
    expect(isMoney(null)).toBe(false);
    expect(isMoney(undefined)).toBe(false);
    expect(isMoney("100")).toBe(false);
    expect(isMoney(100)).toBe(false);
  });
  it("rejects objects missing fields or with wrong types", () => {
    expect(isMoney({ amount: 100, currency: "IDR" })).toBe(false); // number, not bigint
    expect(isMoney({ amount: 100n })).toBe(false);
    expect(isMoney({ currency: "IDR" })).toBe(false);
  });
});

describe("add", () => {
  it("adds amounts within the same currency", () => {
    expect(add(idr(1500n), idr(2500n))).toEqual(idr(4000n));
  });
  it("throws CurrencyMismatchError across currencies", () => {
    expect(() => add(idr(100n), usd(100n))).toThrow(CurrencyMismatchError);
  });
});

describe("subtract", () => {
  it("subtracts amounts within the same currency", () => {
    expect(subtract(idr(5000n), idr(1500n))).toEqual(idr(3500n));
  });
  it("can produce negative results", () => {
    expect(subtract(idr(100n), idr(500n))).toEqual(idr(-400n));
  });
  it("throws CurrencyMismatchError across currencies", () => {
    expect(() => subtract(idr(100n), usd(100n))).toThrow(CurrencyMismatchError);
  });
});

describe("negate / abs / sign predicates", () => {
  it("negate flips sign", () => {
    expect(negate(idr(100n))).toEqual(idr(-100n));
    expect(negate(idr(-100n))).toEqual(idr(100n));
    expect(negate(idr(0n))).toEqual(idr(0n));
  });
  it("abs returns magnitude", () => {
    expect(abs(idr(-500n))).toEqual(idr(500n));
    expect(abs(idr(500n))).toEqual(idr(500n));
  });
  it("isZero / isPositive / isNegative", () => {
    expect(isZero(idr(0n))).toBe(true);
    expect(isPositive(idr(1n))).toBe(true);
    expect(isPositive(idr(0n))).toBe(false);
    expect(isNegative(idr(-1n))).toBe(true);
    expect(isNegative(idr(0n))).toBe(false);
  });
});

describe("equals", () => {
  it("requires same amount and currency", () => {
    expect(equals(idr(100n), idr(100n))).toBe(true);
    expect(equals(idr(100n), idr(200n))).toBe(false);
    expect(equals(idr(100n), usd(100n))).toBe(false);
  });
});

describe("compare", () => {
  it("returns -1, 0, 1", () => {
    expect(compare(idr(100n), idr(200n))).toBe(-1);
    expect(compare(idr(200n), idr(100n))).toBe(1);
    expect(compare(idr(100n), idr(100n))).toBe(0);
  });
  it("throws CurrencyMismatchError across currencies", () => {
    expect(() => compare(idr(100n), usd(100n))).toThrow(CurrencyMismatchError);
  });
});

describe("multiply by bigint", () => {
  it("does exact integer multiplication, no rounding", () => {
    expect(multiply(idr(1500n), 3n)).toEqual(idr(4500n));
    expect(multiply(idr(1500n), 0n)).toEqual(idr(0n));
    expect(multiply(idr(1500n), -2n)).toEqual(idr(-3000n));
  });
});

describe("multiply by number — exact (no rounding needed)", () => {
  it("250 * 0.5 = 125 in every mode", () => {
    expect(multiply(usd(250n), 0.5).amount).toBe(125n);
    expect(multiply(usd(250n), 0.5, { rounding: "halfUp" }).amount).toBe(125n);
    expect(multiply(usd(250n), 0.5, { rounding: "halfEven" }).amount).toBe(125n);
    expect(multiply(usd(250n), 0.5, { rounding: "down" }).amount).toBe(125n);
  });
});

describe("multiply by number — rounding modes at the half-cent", () => {
  // 251 * 0.5 = 125.5 — exactly halfway, neighbours are 125 and 126.
  it("251 * 0.5: halfUp -> 126, halfEven -> 126 (even), down -> 125", () => {
    expect(multiply(usd(251n), 0.5, { rounding: "halfUp" }).amount).toBe(126n);
    expect(multiply(usd(251n), 0.5, { rounding: "halfEven" }).amount).toBe(126n);
    expect(multiply(usd(251n), 0.5, { rounding: "down" }).amount).toBe(125n);
  });

  // 253 * 0.5 = 126.5 — halfway, neighbours are 126 (even) and 127.
  it("253 * 0.5: halfUp -> 127, halfEven -> 126 (even), down -> 126", () => {
    expect(multiply(usd(253n), 0.5, { rounding: "halfUp" }).amount).toBe(127n);
    expect(multiply(usd(253n), 0.5, { rounding: "halfEven" }).amount).toBe(126n);
    expect(multiply(usd(253n), 0.5, { rounding: "down" }).amount).toBe(126n);
  });

  it("default rounding is halfEven (banker's)", () => {
    // No explicit mode — must match the halfEven outcome.
    expect(multiply(usd(253n), 0.5).amount).toBe(126n);
    expect(multiply(usd(251n), 0.5).amount).toBe(126n);
  });
});

describe("multiply — Indonesian PPN at 7.5%", () => {
  // PPN 7.5% on Rp 100. 100 * 0.075 = 7.5 — exactly halfway between 7 and 8.
  it("Rp 100 * 0.075", () => {
    expect(multiply(idr(100n), 0.075, { rounding: "halfEven" }).amount).toBe(8n); // 8 is even
    expect(multiply(idr(100n), 0.075, { rounding: "halfUp" }).amount).toBe(8n);
    expect(multiply(idr(100n), 0.075, { rounding: "down" }).amount).toBe(7n);
  });

  // 1000 * 0.075 = 75 — exact, no rounding.
  it("Rp 1000 * 0.075 = 75 exactly", () => {
    expect(multiply(idr(1000n), 0.075).amount).toBe(75n);
  });
});

describe("multiply — negative amounts", () => {
  // -253 * 0.5 = -126.5 — halfway, halfEven picks the even neighbour (-126).
  it("rounds magnitude consistently for negative bigints", () => {
    expect(multiply(usd(-253n), 0.5, { rounding: "halfEven" }).amount).toBe(-126n);
    expect(multiply(usd(-253n), 0.5, { rounding: "halfUp" }).amount).toBe(-127n);
    expect(multiply(usd(-253n), 0.5, { rounding: "down" }).amount).toBe(-126n);
  });
});

describe("multiply — very large bigints", () => {
  it("preserves precision past Number.MAX_SAFE_INTEGER", () => {
    // 2 ** 60 = 1_152_921_504_606_846_976n  (well past MAX_SAFE_INTEGER)
    const huge = idr(1_152_921_504_606_846_976n);
    expect(multiply(huge, 2n).amount).toBe(2_305_843_009_213_693_952n);
    // 0.5 of an even huge bigint is exact.
    expect(multiply(huge, 0.5).amount).toBe(576_460_752_303_423_488n);
  });
});

describe("format — IDR (no minor unit)", () => {
  it("formats whole rupiah", () => {
    // Intl in Bun/Node renders id-ID as "Rp1.500.000" (no space). Test the
    // structural pieces so we are robust to ICU minor differences.
    const out = format(idr(1_500_000n));
    expect(out).toContain("Rp");
    expect(out).toContain("1.500.000");
    expect(out).not.toContain(",");
  });
  it("formats negative rupiah", () => {
    const out = format(idr(-1_500_000n));
    expect(out).toContain("1.500.000");
    expect(out).toMatch(/-|\(/); // either "-Rp..." or "(Rp...)"
  });
  it("formats zero rupiah", () => {
    expect(format(idr(0n))).toContain("0");
  });
});

describe("format — USD (minor unit)", () => {
  it("$1,500.00 from 150_000 cents", () => {
    expect(format(usd(150_000n), { locale: "en-US" })).toBe("$1,500.00");
  });
  it("$0.05 from 5 cents", () => {
    expect(format(usd(5n), { locale: "en-US" })).toBe("$0.05");
  });
  it("$0.00 from 0 cents", () => {
    expect(format(usd(0n), { locale: "en-US" })).toBe("$0.00");
  });
  it("preserves precision for very large totals", () => {
    // 1_234_567_890_123_456_789n cents = $12,345,678,901,234,567.89.
    // Past Number.MAX_SAFE_INTEGER (~9.007e15), which is what makes this a
    // real precision test — naive `Number(bigint)` would round here.
    const out = format(usd(1_234_567_890_123_456_789n), { locale: "en-US" });
    expect(out).toBe("$12,345,678,901,234,567.89");
  });
});

describe("format — locale and currency overrides", () => {
  it("respects an explicit locale", () => {
    const out = format(usd(150_000n), { locale: "de-DE", currency: "EUR" });
    // German locale: "1.500,00 €" — assert structural bits.
    expect(out).toContain("1.500,00");
    expect(out).toContain("€"); // €
  });
});

describe("toJSON / fromJSON", () => {
  it("round-trips ordinary amounts", () => {
    const m = idr(1_500_000n);
    expect(fromJSON(toJSON(m))).toEqual(m);
  });
  it("round-trips very large bigints (no precision loss)", () => {
    const huge = { amount: 12_345_678_901_234_567_890n, currency: "USD" } as Money;
    const json = toJSON(huge);
    expect(json.amount).toBe("12345678901234567890");
    expect(fromJSON(json)).toEqual(huge);
  });
  it("round-trips negative amounts", () => {
    const m = usd(-12345n);
    expect(fromJSON(toJSON(m))).toEqual(m);
  });
  it("toJSON output is JSON.stringify-safe", () => {
    const m = idr(1_500_000n);
    const s = JSON.stringify(toJSON(m));
    expect(JSON.parse(s)).toEqual({ amount: "1500000", currency: "IDR" });
  });
});

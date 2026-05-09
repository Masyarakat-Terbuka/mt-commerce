import { describe, it, expect } from "vitest";
import { isValidE164, normalizePhone } from "../../src/lib/phone.ts";

describe("normalizePhone", () => {
  it("returns empty for empty input", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
  });

  it("strips whitespace, dashes, and parentheses", () => {
    expect(normalizePhone("+62 812-3456-7890")).toBe("+6281234567890");
    expect(normalizePhone("(0812) 3456 7890")).toBe("+6281234567890");
  });

  it("converts Indonesian local form to E.164", () => {
    expect(normalizePhone("081234567890")).toBe("+6281234567890");
  });

  it("leaves an already-E.164 number alone", () => {
    expect(normalizePhone("+6281234567890")).toBe("+6281234567890");
  });

  it("does not touch non-zero non-plus numbers (caller decides)", () => {
    expect(normalizePhone("6281234567890")).toBe("6281234567890");
  });

  it("does not assume +62 for `00` prefixes", () => {
    // `00...` is the international dialing prefix in some countries; we
    // leave it for the validator to reject rather than silently producing
    // `+620...`.
    expect(normalizePhone("0012345")).toBe("0012345");
  });
});

describe("isValidE164", () => {
  it("accepts E.164 with leading +", () => {
    expect(isValidE164("+6281234567890")).toBe(true);
    expect(isValidE164("+12025550100")).toBe(true);
  });

  it("accepts E.164 without leading + (regex permits)", () => {
    expect(isValidE164("6281234567890")).toBe(true);
  });

  it("rejects local-form 0 prefix", () => {
    expect(isValidE164("081234567890")).toBe(false);
  });

  it("rejects empty and obviously short numbers", () => {
    expect(isValidE164("")).toBe(false);
    expect(isValidE164("+")).toBe(false);
    expect(isValidE164("+1")).toBe(false);
  });

  it("rejects too-long numbers", () => {
    // E.164 max is 15 digits.
    expect(isValidE164("+1234567890123456")).toBe(false);
  });
});

describe("normalizePhone + isValidE164 round trip", () => {
  it("a typed Indonesian local number normalizes into a valid E.164", () => {
    expect(isValidE164(normalizePhone("081234567890"))).toBe(true);
  });

  it("a phone with messaging-app formatting still reaches valid E.164", () => {
    expect(isValidE164(normalizePhone("+62 812-3456-7890"))).toBe(true);
  });

  it("an obviously broken number stays invalid after normalization", () => {
    expect(isValidE164(normalizePhone("abc"))).toBe(false);
  });
});

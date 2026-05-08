import { describe, expect, it } from "vitest";
import { normalizeIndonesianPhone, toE164 } from "../src/phone.js";

describe("normalizeIndonesianPhone", () => {
  it("turns the national trunk form into the country-coded form", () => {
    expect(normalizeIndonesianPhone("08123456789")).toBe("628123456789");
  });

  it("keeps already-country-coded numbers", () => {
    expect(normalizeIndonesianPhone("628123456789")).toBe("628123456789");
  });

  it("strips a leading + and separators", () => {
    expect(normalizeIndonesianPhone("+62 812-3456-789")).toBe("628123456789");
    expect(normalizeIndonesianPhone("+62 812 3456 789")).toBe("628123456789");
    expect(normalizeIndonesianPhone("(+62) 812.3456.789")).toBe("628123456789");
  });

  it("treats subscriber-only digits as Indonesian", () => {
    expect(normalizeIndonesianPhone("8123456789")).toBe("628123456789");
  });

  it("handles a number whose subscriber portion contains a leading zero after the trunk", () => {
    // `0` (trunk) + `8` + `0123...` — only the FIRST zero is the trunk
    expect(normalizeIndonesianPhone("0801234567")).toBe("62801234567");
  });

  it("rejects empty input", () => {
    expect(() => normalizeIndonesianPhone("")).toThrow(/empty/);
    expect(() => normalizeIndonesianPhone("   ")).toThrow(/empty/);
  });

  it("rejects strings that contain no digits", () => {
    expect(() => normalizeIndonesianPhone("abc-def")).toThrow(/empty/);
  });

  it("rejects numbers that are too short to be Indonesian", () => {
    expect(() => normalizeIndonesianPhone("0812")).toThrow(/too short/);
  });

  it("rejects numbers that exceed Meta's 15-digit cap", () => {
    expect(() => normalizeIndonesianPhone("6281234567890123")).toThrow(
      /too long/,
    );
  });
});

describe("toE164", () => {
  it("prefixes with +", () => {
    expect(toE164("628123456789")).toBe("+628123456789");
  });
});

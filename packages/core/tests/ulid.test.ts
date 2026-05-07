import { describe, expect, it } from "vitest";
import { id, rawUlid } from "../src/ulid.js";

describe("id", () => {
  it("returns a value with the requested prefix", () => {
    const productId = id("prod");
    expect(productId.startsWith("prod_")).toBe(true);
  });

  it("returns a syntactically distinct value on each call", () => {
    // ULIDs are time-ordered with random bits; consecutive calls within the
    // same millisecond must still differ thanks to the random component.
    const a = id("ord");
    const b = id("ord");
    expect(a).not.toBe(b);
  });

  it("produces a well-formed prefixed ULID", () => {
    const value = id("cust");
    // prefix + underscore + 26-char Crockford-Base32 ULID
    expect(value).toMatch(/^cust_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("rawUlid returns a 26-character ULID", () => {
    expect(rawUlid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

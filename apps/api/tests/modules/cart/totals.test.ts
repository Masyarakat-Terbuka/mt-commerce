/**
 * Pure-function tests for `CartService.getTotals`.
 *
 * `getTotals` is the meat of the cart module — the order module will lean
 * on the same function for its line totals, and the storefront and admin
 * both render its output verbatim. We pin:
 *
 *   - empty cart → all-zero `Money` in the cart's currency
 *   - line math at IDR (no minor unit) and at a 2-minor-unit currency
 *   - PPN tax application at the default 0.11 rate
 *   - bigint correctness for amounts > Number.MAX_SAFE_INTEGER
 *
 * The tax rate is pulled from the API's `env` (which defaults to 0.11 when
 * the env var is unset, matching `lib/env.ts`). The vitest config does
 * NOT set `TAX_PPN_RATE`, so these tests exercise the production default.
 *
 * `getTotals` does not touch the database, so we instantiate the service
 * with a no-op repository (no method here is called).
 */
import { describe, expect, it } from "vitest";
import { CartServiceImpl } from "../../../src/modules/cart/service.js";
import type { CartRepository } from "../../../src/modules/cart/repository.js";
import type { Cart, CartItem } from "../../../src/modules/cart/types.js";

// A repository that throws on any call — `getTotals` must not reach for it.
const noopRepo = {
  insertCart: () => {
    throw new Error("getTotals must not call the repository");
  },
} as unknown as CartRepository;

const service = new CartServiceImpl(noopRepo);

const FIXED_DATE = new Date("2026-05-07T12:00:00.000Z");

function makeItem(
  amount: bigint,
  quantity: number,
  currency = "IDR",
): CartItem {
  return {
    id: `ci_${amount}_${quantity}`,
    cartId: "cart_test",
    variantId: `var_${amount}`,
    quantity,
    unitPrice: { amount, currency },
    lineTotal: { amount: amount * BigInt(quantity), currency },
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function makeCart(items: CartItem[], currency = "IDR"): Cart {
  return {
    id: "cart_test",
    customerId: null,
    currency,
    status: "active",
    items,
    expiresAt: new Date(FIXED_DATE.getTime() + 30 * 24 * 60 * 60 * 1000),
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getTotals — empty cart", () => {
  it("returns all zeros in the cart's currency", () => {
    const totals = service.getTotals(makeCart([], "IDR"));
    expect(totals.subtotal).toEqual({ amount: 0n, currency: "IDR" });
    expect(totals.tax).toEqual({ amount: 0n, currency: "IDR" });
    expect(totals.shipping).toEqual({ amount: 0n, currency: "IDR" });
    expect(totals.total).toEqual({ amount: 0n, currency: "IDR" });
  });

  it("preserves the currency for an empty USD cart too", () => {
    const totals = service.getTotals(makeCart([], "USD"));
    expect(totals.subtotal.currency).toBe("USD");
    expect(totals.total.currency).toBe("USD");
  });
});

describe("getTotals — single IDR line", () => {
  it("subtotal = unit_price * quantity (no minor unit)", () => {
    // Rp 100.000 × 1 = Rp 100.000.
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart);
    expect(totals.subtotal.amount).toBe(100_000n);
    // Tax = Rp 100.000 × 0.11 = Rp 11.000 (exact, no rounding).
    expect(totals.tax.amount).toBe(11_000n);
    expect(totals.shipping.amount).toBe(0n);
    // Total = Rp 111.000.
    expect(totals.total.amount).toBe(111_000n);
  });

  it("multiplies quantity correctly", () => {
    // Rp 25.000 × 4 = Rp 100.000.
    const cart = makeCart([makeItem(25_000n, 4)]);
    const totals = service.getTotals(cart);
    expect(totals.subtotal.amount).toBe(100_000n);
  });
});

describe("getTotals — multiple lines", () => {
  it("sums subtotal across lines in the same currency", () => {
    // 50_000 × 2  + 30_000 × 1  + 10_000 × 5 = 100_000 + 30_000 + 50_000 = 180_000.
    const cart = makeCart([
      makeItem(50_000n, 2),
      makeItem(30_000n, 1),
      makeItem(10_000n, 5),
    ]);
    const totals = service.getTotals(cart);
    expect(totals.subtotal.amount).toBe(180_000n);
    expect(totals.tax.amount).toBe(19_800n); // 180_000 * 0.11
    expect(totals.total.amount).toBe(199_800n);
  });
});

describe("getTotals — tax rounding (halfEven)", () => {
  it("rounds Rp 99.999 × 0.11 according to banker's rounding", () => {
    const cart = makeCart([makeItem(99_999n, 1)]);
    const totals = service.getTotals(cart);
    expect(totals.subtotal.amount).toBe(99_999n);
    // Money.multiply treats the number factor as an exact ratio via
    // toRatio: 0.11 → 11/100. The integer math is then
    //   99_999 * 11 = 1_099_989
    //   1_099_989 / 100 = quotient 10_999, remainder 89
    // halfEven looks at `2 * remainder` vs `denominator`:
    //   doubled = 178, denominator = 100 → 178 > 100 → round up.
    // So the answer is 11_000 (NOT 10_999 — the remainder is past half).
    expect(totals.tax.amount).toBe(11_000n);
    expect(totals.total.amount).toBe(99_999n + 11_000n);
  });

  it("at exact half, halfEven rounds to the nearest even", () => {
    // Pick a subtotal where subtotal × 0.11 is exactly *.5 to trigger the
    // half-even tie-break: 50 × 0.11 = 5.5 → halfEven → 6 (next even).
    const cart = makeCart([makeItem(50n, 1)]);
    const totals = service.getTotals(cart);
    // 50 * 11 = 550 ; / 100 = 5 remainder 50 ; doubled remainder == d (100)
    // → tie → quotient (5) is odd, so round up to 6.
    expect(totals.tax.amount).toBe(6n);
  });
});

describe("getTotals — shipping placeholder", () => {
  it("is always zero in the cart's currency", () => {
    const cart = makeCart([makeItem(100_000n, 1, "IDR")], "IDR");
    expect(service.getTotals(cart).shipping).toEqual({
      amount: 0n,
      currency: "IDR",
    });

    const usdCart = makeCart([makeItem(1_000n, 1, "USD")], "USD");
    expect(service.getTotals(usdCart).shipping).toEqual({
      amount: 0n,
      currency: "USD",
    });
  });
});

describe("getTotals — bigint correctness for huge IDR amounts", () => {
  it("handles amounts beyond Number.MAX_SAFE_INTEGER", () => {
    // Number.MAX_SAFE_INTEGER ≈ 9.007e15. We use a unit price well past
    // that to verify the math stays in bigint land. 10n ** 17n = 1e17.
    const huge = 10n ** 17n;
    const cart = makeCart([makeItem(huge, 3)]);
    const totals = service.getTotals(cart);
    expect(totals.subtotal.amount).toBe(huge * 3n);
    // tax = huge*3 * 11 / 100 — still a bigint, no precision loss.
    const expectedTax = (huge * 3n * 11n) / 100n;
    expect(totals.tax.amount).toBe(expectedTax);
    expect(totals.total.amount).toBe(huge * 3n + expectedTax);
    // Sanity: the answer is past Number.MAX_SAFE_INTEGER too — proves the
    // computation never silently passed through a `Number`.
    expect(totals.total.amount > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("getTotals — currency consistency", () => {
  it("the four output Money values share the cart's currency", () => {
    const cart = makeCart([makeItem(1_000n, 2)], "IDR");
    const totals = service.getTotals(cart);
    expect(totals.subtotal.currency).toBe("IDR");
    expect(totals.tax.currency).toBe("IDR");
    expect(totals.shipping.currency).toBe("IDR");
    expect(totals.total.currency).toBe("IDR");
  });
});

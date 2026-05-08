/**
 * Cart `getTotals(cart, opts)` integration with the tax module's
 * `AppliedTaxRate` shape.
 *
 * Pins:
 *   - Passing `opts.taxRate = { code:"PPN_11", rateBasisPoints:1100 }`
 *     produces tax = subtotal × 0.11 with the same halfEven rounding
 *     the env-var path uses (matching `cart/totals.test.ts`).
 *   - The applied rate is echoed on `totals.taxRate` so the wire layer
 *     can render "PPN 11%" alongside the amount.
 *   - `opts.shipping` replaces the default `zero(currency)`; currency
 *     parity is enforced.
 *   - With `opts` omitted, the legacy env-var fallback still works
 *     (regression coverage for tests / unseeded dev DBs).
 */
import { describe, expect, it } from "vitest";
import { CartServiceImpl } from "../../../src/modules/cart/service.js";
import type { CartRepository } from "../../../src/modules/cart/repository.js";
import type { Cart, CartItem } from "../../../src/modules/cart/types.js";
import { ValidationError } from "../../../src/lib/errors.js";

const noopRepo = {
  insertCart: () => {
    throw new Error("getTotals must not call the repository");
  },
} as unknown as CartRepository;

const service = new CartServiceImpl(noopRepo);

const NOW = new Date("2026-05-07T12:00:00.000Z");

function makeItem(amount: bigint, quantity: number, currency = "IDR"): CartItem {
  return {
    id: `ci_${amount}_${quantity}`,
    cartId: "cart_test",
    variantId: `var_${amount}`,
    quantity,
    unitPrice: { amount, currency },
    lineTotal: { amount: amount * BigInt(quantity), currency },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeCart(items: CartItem[], currency = "IDR"): Cart {
  return {
    id: "cart_test",
    customerId: null,
    currency,
    status: "active",
    items,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const PPN_11 = { code: "PPN_11", rateBasisPoints: 1100 };

describe("getTotals with opts.taxRate (tax module integration)", () => {
  it("applies the rate and echoes it on the response", async () => {
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart, { taxRate: PPN_11 });
    expect(totals.subtotal.amount).toBe(100_000n);
    expect(totals.tax.amount).toBe(11_000n);
    expect(totals.total.amount).toBe(111_000n);
    expect(totals.taxRate).toEqual({ code: "PPN_11", basisPoints: 1100 });
    // `subtotalIncludingTax` is the tax-inclusive items line (excludes
    // shipping). Storefront displays this as "Subtotal (termasuk PPN)".
    expect(totals.subtotalIncludingTax.amount).toBe(111_000n);
    expect(totals.subtotalIncludingTax.currency).toBe("IDR");
  });

  it("subtotalIncludingTax adds shipping-free", async () => {
    // Even when shipping is supplied, `subtotalIncludingTax` excludes
    // shipping so the storefront can render the items-only "you-pay"
    // line separately from shipping.
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart, {
      taxRate: PPN_11,
      shipping: { amount: 15_000n, currency: "IDR" },
    });
    expect(totals.subtotalIncludingTax.amount).toBe(111_000n);
    expect(totals.shipping.amount).toBe(15_000n);
    expect(totals.total.amount).toBe(126_000n);
  });

  it("rounds halfEven on a remainder-past-half subtotal", async () => {
    // 99_999 × 11% = 10_999 r 89 → 2 * 89 > 100 → up → 11_000
    const cart = makeCart([makeItem(99_999n, 1)]);
    const totals = service.getTotals(cart, { taxRate: PPN_11 });
    expect(totals.tax.amount).toBe(11_000n);
  });

  it("at exact half, halfEven rounds to nearest even", async () => {
    // 50 × 0.11 = 5.5 → halfEven → 6 (next even)
    const cart = makeCart([makeItem(50n, 1)]);
    const totals = service.getTotals(cart, { taxRate: PPN_11 });
    expect(totals.tax.amount).toBe(6n);
  });

  it("zero rate produces zero tax and a non-null taxRate echo", async () => {
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart, {
      taxRate: { code: "ZERO", rateBasisPoints: 0 },
    });
    expect(totals.tax.amount).toBe(0n);
    expect(totals.taxRate).toEqual({ code: "ZERO", basisPoints: 0 });
  });
});

describe("getTotals with opts.shipping (shipping module integration)", () => {
  it("uses the supplied shipping amount", async () => {
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart, {
      taxRate: PPN_11,
      shipping: { amount: 15_000n, currency: "IDR" },
    });
    expect(totals.shipping.amount).toBe(15_000n);
    expect(totals.total.amount).toBe(100_000n + 11_000n + 15_000n);
  });

  it("rejects a currency-mismatched shipping amount with ValidationError", async () => {
    const cart = makeCart([makeItem(100_000n, 1)], "IDR");
    expect(() =>
      service.getTotals(cart, {
        taxRate: PPN_11,
        shipping: { amount: 1_000n, currency: "USD" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("getTotals fallback when opts is omitted", () => {
  it("still produces the legacy env-var tax (taxRate echo is null)", async () => {
    // env.taxPpnRate defaults to 0.11 in the vitest environment
    // (matches `cart/totals.test.ts`).
    const cart = makeCart([makeItem(100_000n, 1)]);
    const totals = service.getTotals(cart);
    expect(totals.tax.amount).toBe(11_000n);
    expect(totals.taxRate).toBeNull();
    expect(totals.shipping.amount).toBe(0n);
  });
});

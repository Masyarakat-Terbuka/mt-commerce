// @vitest-environment jsdom
/**
 * `CartPage` state tests.
 *
 * Covers the four states a buyer ever sees on `/cart`:
 *
 *   - loading skeleton on first paint (no cached cart)
 *   - empty state with the products CTA when the cart is non-null but empty
 *   - data state with one row per line item
 *   - undo-remove: clicking "Remove" replaces the line with an undo strip
 *     and clicking "Undo" within the window restores it without calling
 *     the `removeItem` mutation
 *
 * The tests stub `./CartProvider.js` — the real provider wires SDK calls
 * to the network. We don't want that here; we want to assert on what the
 * page renders given a known context. The mock exposes a `setMockCart`
 * helper so each test owns the slice it cares about.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

interface MockCart {
  id: string;
  customerId: string | null;
  currency: string;
  status: string;
  items: Array<{
    id: string;
    variantId: string;
    quantity: number;
    unitPrice: { amount: bigint; currency: string };
    lineTotal: { amount: bigint; currency: string };
  }>;
  totals: {
    subtotal: { amount: bigint; currency: string };
    tax: { amount: bigint; currency: string };
    shipping: { amount: bigint; currency: string };
    subtotalIncludingTax: { amount: bigint; currency: string };
    total: { amount: bigint; currency: string };
    taxRate: { code: string; basisPoints: number } | null;
    taxRateCode: string | null;
    taxRateBasisPoints: number | null;
  };
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface MockCartContextOverrides {
  cart?: MockCart | null;
  loading?: boolean;
  error?: string | null;
}

let mockState: {
  cart: MockCart | null;
  loading: boolean;
  error: string | null;
};
const removeItemSpy = vi.fn();
const updateItemSpy = vi.fn();

function resetMockState() {
  mockState = { cart: null, loading: false, error: null };
  removeItemSpy.mockReset();
  updateItemSpy.mockReset();
}
resetMockState();

function setMockCart(overrides: MockCartContextOverrides) {
  if (overrides.cart !== undefined) mockState.cart = overrides.cart;
  if (overrides.loading !== undefined) mockState.loading = overrides.loading;
  if (overrides.error !== undefined) mockState.error = overrides.error;
}

vi.mock("../../src/islands/CartProvider.js", () => ({
  CartProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useCart: () => ({
    cart: mockState.cart,
    loading: mockState.loading,
    error: mockState.error,
    itemCount: mockState.cart?.items.reduce((n, i) => n + i.quantity, 0) ?? 0,
    addItem: vi.fn(),
    updateItem: updateItemSpy,
    removeItem: removeItemSpy,
    clear: vi.fn(),
    openDrawer: vi.fn(),
  }),
  CART_CHANGED_EVENT_NAME: "mt:cart-changed-test",
  openCartDrawer: vi.fn(),
}));

import CartPage from "../../src/islands/CartPage";

const baseProps = {
  locale: "id",
  productsHref: "/produk",
  checkoutHref: "/checkout",
  titleLabel: "Keranjang",
  emptyLabel: "Keranjang masih kosong.",
  emptyCtaLabel: "Lihat produk",
  subtotalIncludingTaxLabel: "Subtotal (termasuk pajak)",
  taxIncludedNote: "termasuk PPN 11%",
  shippingLabel: "Ongkir",
  totalLabel: "Total",
  checkoutCtaLabel: "Lanjut ke checkout",
  removeLabel: "Hapus",
  removedPendingLabel: "Item dihapus.",
  undoRemoveLabel: "Urungkan",
  quantityLabel: "Jumlah",
  productFallbackLabel: "Produk",
};

beforeEach(() => {
  resetMockState();
  // Clean any cart-info entries written by previous renders.
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});

function makeCart(items: MockCart["items"]): MockCart {
  return {
    id: "cart_1",
    customerId: null,
    currency: "IDR",
    status: "active",
    items,
    totals: {
      subtotal: { amount: 0n, currency: "IDR" },
      tax: { amount: 0n, currency: "IDR" },
      shipping: { amount: 0n, currency: "IDR" },
      subtotalIncludingTax: { amount: 0n, currency: "IDR" },
      total: { amount: 0n, currency: "IDR" },
      taxRate: null,
      taxRateCode: null,
      taxRateBasisPoints: null,
    },
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("CartPage", () => {
  it("renders the loading skeleton on first paint when no cart is cached", () => {
    setMockCart({ cart: null, loading: true });
    const { container } = render(<CartPage {...baseProps} />);
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
  });

  it("renders the empty state + products CTA when the cart has no items", () => {
    setMockCart({
      cart: makeCart([]),
      loading: false,
    });
    render(<CartPage {...baseProps} />);
    expect(screen.getByText("Keranjang masih kosong.")).toBeInTheDocument();
    const cta = screen.getByText(/Lihat produk/);
    expect(cta).toBeInTheDocument();
    expect(cta.closest("a")).toHaveAttribute("href", "/produk");
  });

  it("renders one line per item when the cart has data", () => {
    setMockCart({
      cart: makeCart([
        {
          id: "line_1",
          variantId: "var_a",
          quantity: 2,
          unitPrice: { amount: 50_000n, currency: "IDR" },
          lineTotal: { amount: 100_000n, currency: "IDR" },
        },
      ]),
      loading: false,
    });
    render(<CartPage {...baseProps} />);
    // No cached product info → line falls back to the generic label.
    expect(screen.getByText("Produk")).toBeInTheDocument();
    expect(screen.getByText("Lanjut ke checkout")).toBeInTheDocument();
  });

  it("queues the removal and shows the undo strip when Hapus is clicked", async () => {
    setMockCart({
      cart: makeCart([
        {
          id: "line_1",
          variantId: "var_a",
          quantity: 1,
          unitPrice: { amount: 50_000n, currency: "IDR" },
          lineTotal: { amount: 50_000n, currency: "IDR" },
        },
      ]),
      loading: false,
    });
    const user = userEvent.setup();
    render(<CartPage {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Hapus" }));

    // Undo strip appears synchronously; the actual removal is deferred
    // by the 4-second timeout, so `removeItem` MUST NOT have been called.
    expect(screen.getByText("Item dihapus.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Urungkan" }),
    ).toBeInTheDocument();
    expect(removeItemSpy).not.toHaveBeenCalled();
  });

  it("undoing the removal restores the line synchronously", async () => {
    setMockCart({
      cart: makeCart([
        {
          id: "line_1",
          variantId: "var_a",
          quantity: 1,
          unitPrice: { amount: 50_000n, currency: "IDR" },
          lineTotal: { amount: 50_000n, currency: "IDR" },
        },
      ]),
      loading: false,
    });
    const user = userEvent.setup();
    render(<CartPage {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Hapus" }));
    expect(screen.getByText("Item dihapus.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Urungkan" }));

    // Original line is back — undo cancels the timer before it fires.
    expect(screen.queryByText("Item dihapus.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hapus" })).toBeInTheDocument();
    expect(removeItemSpy).not.toHaveBeenCalled();
  });
});

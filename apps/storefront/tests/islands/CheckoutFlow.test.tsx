// @vitest-environment jsdom
/**
 * `CheckoutFlow` gate tests.
 *
 * The flow is a four-step island; before any step renders, the page
 * decides whether the user can even proceed:
 *
 *   - cart still loading → render the "loading" skeleton
 *   - no cart / empty cart → render the empty-cart copy + products CTA
 *   - cart present but no customer id in localStorage → AddressStep
 *     short-circuits to the guest signup CTA
 *
 * These tests exercise that gate. The deeper step-component validation
 * (radio-required, billing-different gating) lives inside AddressStep
 * with internal SDK fetches and is best tested when the customer-account
 * tests around that surface land.
 *
 * The CartProvider wrapper around CheckoutFlow is stubbed for the same
 * reason as in CartPage tests — we want full control over the cart
 * state and don't want any real SDK calls fired.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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

let mockState: {
  cart: MockCart | null;
  loading: boolean;
  error: string | null;
};

function resetMockState() {
  mockState = { cart: null, loading: false, error: null };
}
resetMockState();

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
    updateItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    openDrawer: vi.fn(),
  }),
  CART_CHANGED_EVENT_NAME: "mt:cart-changed-test",
  openCartDrawer: vi.fn(),
}));

// Stub the SDK so `createClient` inside CheckoutFlowInner doesn't try
// to reach a real API even on the customer-loaded path.
vi.mock("@mt-commerce/sdk", () => ({
  createClient: () => ({
    storefront: {
      checkout: {
        start: vi.fn(),
        setAddresses: vi.fn(),
        setShipping: vi.fn(),
        complete: vi.fn(),
      },
      customer: {
        myAddresses: vi.fn().mockResolvedValue([]),
      },
      shipping: {
        methods: vi.fn().mockResolvedValue([]),
      },
    },
  }),
  ApiError: class ApiError extends Error {
    code?: string;
  },
}));

import CheckoutFlow from "../../src/islands/CheckoutFlow";

const labels = {
  pageTitle: "Checkout",
  loading: "Memuat…",
  emptyCart: "Keranjang masih kosong.",
  emptyCartCta: "Lihat produk",
  steps: {
    address: "Alamat",
    shipping: "Pengiriman",
    payment: "Pembayaran",
    review: "Tinjau",
  },
  address: {
    title: "Alamat pengiriman",
    selectExisting: "Pilih alamat tersimpan",
    addNew: "Tambah alamat baru",
    addNewHint: "",
    addNewIntro: "",
    billingSame: "Sama dengan alamat pengiriman",
    billingDifferent: "Berbeda dari alamat pengiriman",
    billingSelect: "Pilih alamat penagihan",
    continueLabel: "Lanjut",
    empty: "Belum ada alamat tersimpan.",
    guestUnsupported: "Buat akun untuk melanjutkan checkout.",
    guestSignup: "Daftar akun",
    guestHaveAccount: "Sudah punya akun?",
    guestSignIn: "Masuk",
    form: {} as never,
  },
  shipping: {
    title: "",
    selectMethod: "",
    empty: "",
    continueLabel: "",
  },
  payment: {
    title: "",
    manualBankTransfer: "",
    manualBankTransferNote: "",
    continueLabel: "",
  },
  review: {
    title: "",
    confirm: "",
    confirming: "",
    addressLabel: "",
    billingLabel: "",
    shippingLabel: "",
    paymentLabel: "",
    itemsLabel: "",
    edit: "",
  },
  totals: {
    subtotal: "",
    tax: "",
    subtotalIncludingTax: "",
    taxIncludedNote: "",
    shipping: "",
    total: "",
  },
  errors: {
    generic: "",
    unknownStep: "",
    idempotencyConflict: "",
  },
  productFallbackLabel: "Produk",
};

const baseProps = {
  locale: "id-ID",
  apiLocale: "id" as const,
  cartHref: "/cart",
  productsHref: "/produk",
  signUpHref: "/sign-up?next=/checkout",
  signInHref: "/sign-in?next=/checkout",
  confirmedHrefPattern: "/checkout/{id}/confirmed",
  labels,
};

beforeEach(() => {
  resetMockState();
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

describe("CheckoutFlow gates", () => {
  it("renders the loading skeleton while the cart is hydrating", () => {
    mockState.cart = null;
    mockState.loading = true;
    const { container } = render(<CheckoutFlow {...baseProps} />);
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
  });

  it("renders the empty-cart copy + products CTA when the cart is null", () => {
    mockState.cart = null;
    mockState.loading = false;
    render(<CheckoutFlow {...baseProps} />);
    expect(screen.getByText("Keranjang masih kosong.")).toBeInTheDocument();
    const cta = screen.getByText(/Lihat produk/);
    expect(cta.closest("a")).toHaveAttribute("href", "/produk");
  });

  it("renders the empty-cart copy when the cart is non-null but has zero items", () => {
    mockState.cart = makeCart([]);
    mockState.loading = false;
    render(<CheckoutFlow {...baseProps} />);
    expect(screen.getByText("Keranjang masih kosong.")).toBeInTheDocument();
  });

  it("renders the guest signup CTA on the address step when no customer id is in localStorage", () => {
    mockState.cart = makeCart([
      {
        id: "line_1",
        variantId: "var_a",
        quantity: 1,
        unitPrice: { amount: 50_000n, currency: "IDR" },
        lineTotal: { amount: 50_000n, currency: "IDR" },
      },
    ]);
    mockState.loading = false;
    // Note: localStorage is cleared in beforeEach so customerId is null.
    render(<CheckoutFlow {...baseProps} />);
    expect(
      screen.getByText("Buat akun untuk melanjutkan checkout."),
    ).toBeInTheDocument();
    const signupLink = screen.getByText("Daftar akun");
    expect(signupLink.closest("a")).toHaveAttribute(
      "href",
      "/sign-up?next=/checkout",
    );
  });
});

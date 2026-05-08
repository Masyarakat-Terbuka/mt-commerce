/**
 * Checkout service — unit tests against in-memory fakes.
 *
 * Same pattern as the cart and customer service tests. We construct
 * `CheckoutServiceImpl` with three fakes:
 *
 *   1. A `CheckoutRepository` backed by `Map`s for checkouts, events,
 *      and order-intents, plus the cross-module read/write seams
 *      (cart snapshot, address fetch, mark-cart-converted).
 *
 *   2. A `CartService` fake that returns deterministic carts and totals.
 *      We only stub the methods the checkout service calls
 *      (`getCartById`, `getTotals`).
 *
 *   3. A `CustomerService` fake that hands back addresses by id and
 *      a customer record. Only the methods the checkout service touches
 *      are stubbed.
 *
 * The cart service interface is wide — we cast a partial fake to the
 * full interface because the rest of the methods are unreachable from
 * the checkout flow.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { CheckoutServiceImpl } from "../../../src/modules/checkout/service.js";
import { events } from "../../../src/modules/checkout/events.js";
import type {
  CartSnapshotForCompletion,
  CheckoutRepository,
} from "../../../src/modules/checkout/repository.js";
import type {
  CheckoutEventRow,
  CheckoutRow,
  CustomerAddressRow,
  NewCheckoutEventRow,
  NewCheckoutRow,
  NewOrderIntentRow,
  OrderIntentRow,
} from "../../../src/db/schema/index.js";
import type { Cart, CartService } from "../../../src/modules/cart/index.js";
import type {
  Customer,
  CustomerAddress,
  CustomerService,
} from "../../../src/modules/customer/index.js";
import type { ShippingService } from "../../../src/modules/shipping/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../src/lib/errors.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStore {
  checkouts: Map<string, CheckoutRow>;
  events: CheckoutEventRow[];
  orderIntents: Map<string, OrderIntentRow>;
  carts: Map<string, { row: { id: string; status: string }; items: Array<{
    id: string;
    cartId: string;
    variantId: string;
    quantity: number;
    unitPriceAmount: bigint;
    unitPriceCurrency: string;
    createdAt: Date;
    updatedAt: Date;
  }> }>;
  addresses: Map<string, CustomerAddressRow>;
  cartConverted: Set<string>;
  clock: number;
}

function createStore(): FakeStore {
  return {
    checkouts: new Map(),
    events: [],
    orderIntents: new Map(),
    carts: new Map(),
    addresses: new Map(),
    cartConverted: new Set(),
    clock: 0,
  };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

interface FakeRepoOptions {
  /**
   * Optional mutex applied to `withTransaction`. When set, only one
   * transaction body runs at a time — used to model `SELECT ... FOR
   * UPDATE` row-locking semantics in concurrent-completion tests.
   */
  serializeTransactions?: boolean;
  /**
   * Test seam for B1's belt-and-suspenders branch: throw a synthetic
   * Postgres unique-violation from `insertOrderIntent`.
   */
  orderIntentInsertError?: unknown;
}

function createFakeRepo(
  store: FakeStore,
  options: FakeRepoOptions = {},
): CheckoutRepository {
  let txMutex: Promise<unknown> = Promise.resolve();

  const repo: CheckoutRepository = {
    async insertCheckout(row: NewCheckoutRow): Promise<CheckoutRow> {
      const now = tick(store);
      const checkout: CheckoutRow = {
        id: row.id,
        cartId: row.cartId,
        customerId: row.customerId ?? null,
        state: row.state ?? "pending",
        shippingAddressId: row.shippingAddressId ?? null,
        billingAddressId: row.billingAddressId ?? null,
        email: row.email ?? null,
        shippingMethodCode: row.shippingMethodCode ?? null,
        shippingAmount: row.shippingAmount ?? null,
        shippingCurrency: row.shippingCurrency ?? null,
        paymentMethod: row.paymentMethod ?? null,
        cancellationReason: row.cancellationReason ?? null,
        idempotencyKey: row.idempotencyKey ?? null,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      };
      store.checkouts.set(checkout.id, checkout);
      return checkout;
    },
    async getCheckoutById(id) {
      return store.checkouts.get(id) ?? null;
    },
    async getCheckoutByIdForUpdate(id) {
      // The in-memory fake has no real row lock — when the test asks
      // for transaction serialisation (`serializeTransactions: true`),
      // the mutex on `withTransaction` provides equivalent ordering.
      return store.checkouts.get(id) ?? null;
    },
    async listCheckouts(filters) {
      let rows = [...store.checkouts.values()];
      if (filters.state) rows = rows.filter((r) => r.state === filters.state);
      if (filters.customerId)
        rows = rows.filter((r) => r.customerId === filters.customerId);
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(start, start + filters.pageSize), total };
    },
    async updateCheckout(id, patch) {
      const existing = store.checkouts.get(id);
      if (!existing) return null;
      const updated: CheckoutRow = {
        ...existing,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.shippingAddressId !== undefined
          ? { shippingAddressId: patch.shippingAddressId }
          : {}),
        ...(patch.billingAddressId !== undefined
          ? { billingAddressId: patch.billingAddressId }
          : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.shippingMethodCode !== undefined
          ? { shippingMethodCode: patch.shippingMethodCode }
          : {}),
        ...(patch.shippingAmount !== undefined
          ? { shippingAmount: patch.shippingAmount }
          : {}),
        ...(patch.shippingCurrency !== undefined
          ? { shippingCurrency: patch.shippingCurrency }
          : {}),
        ...(patch.paymentMethod !== undefined
          ? { paymentMethod: patch.paymentMethod }
          : {}),
        ...(patch.cancellationReason !== undefined
          ? { cancellationReason: patch.cancellationReason }
          : {}),
        ...(patch.idempotencyKey !== undefined
          ? { idempotencyKey: patch.idempotencyKey }
          : {}),
        updatedAt: tick(store),
      };
      store.checkouts.set(id, updated);
      return updated;
    },
    async insertEvent(row: NewCheckoutEventRow): Promise<CheckoutEventRow> {
      const now = tick(store);
      const event: CheckoutEventRow = {
        id: row.id,
        checkoutId: row.checkoutId,
        fromState: row.fromState ?? null,
        toState: row.toState,
        details: (row.details as Record<string, unknown>) ?? {},
        createdAt: now,
      };
      store.events.push(event);
      return event;
    },
    async listEvents(checkoutId) {
      return store.events
        .filter((e) => e.checkoutId === checkoutId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async insertOrderIntent(row: NewOrderIntentRow): Promise<OrderIntentRow> {
      if (options.orderIntentInsertError !== undefined) {
        throw options.orderIntentInsertError;
      }
      const now = tick(store);
      const intent: OrderIntentRow = {
        id: row.id,
        checkoutId: row.checkoutId,
        cartSnapshot: row.cartSnapshot as object,
        totalsSnapshot: row.totalsSnapshot as object,
        shippingAddressSnapshot: row.shippingAddressSnapshot as object,
        billingAddressSnapshot: (row.billingAddressSnapshot as object) ?? null,
        email: row.email,
        shippingMethodCode: row.shippingMethodCode,
        paymentMethod: row.paymentMethod,
        createdAt: now,
      };
      store.orderIntents.set(intent.id, intent);
      return intent;
    },
    async getOrderIntentByCheckoutId(checkoutId) {
      for (const intent of store.orderIntents.values()) {
        if (intent.checkoutId === checkoutId) return intent;
      }
      return null;
    },
    async getCartSnapshotForCompletion(cartId): Promise<CartSnapshotForCompletion | null> {
      const entry = store.carts.get(cartId);
      if (!entry) return null;
      return {
        cart: {
          id: entry.row.id,
          customerId: null,
          currency: "IDR",
          status: entry.row.status,
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        items: entry.items.map((it) => ({
          id: it.id,
          cartId: it.cartId,
          variantId: it.variantId,
          quantity: it.quantity,
          unitPriceAmount: it.unitPriceAmount,
          unitPriceCurrency: it.unitPriceCurrency,
          createdAt: it.createdAt,
          updatedAt: it.updatedAt,
        })),
      };
    },
    async getAddressForSnapshot(addressId) {
      return store.addresses.get(addressId) ?? null;
    },
    async markCartConverted(cartId) {
      store.cartConverted.add(cartId);
    },
    async withTransaction(fn) {
      // In-memory fake — no real transactional semantics. Tests that need
      // to assert atomicity should use the real repo against a Postgres
      // instance; the unit suite focuses on the orchestration logic.
      //
      // When `serializeTransactions` is set, callers run one-at-a-time
      // through a chained promise. This models the FOR UPDATE row lock:
      // the second concurrent caller waits for the first to commit, then
      // observes the committed state.
      if (!options.serializeTransactions) {
        return fn(repo);
      }
      const previous = txMutex;
      let resolveSelf: () => void = () => undefined;
      const self = new Promise<void>((resolve) => {
        resolveSelf = resolve;
      });
      txMutex = self;
      try {
        await previous;
        return await fn(repo);
      } finally {
        resolveSelf();
      }
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-07T12:00:00.000Z");

function makeCart(overrides: Partial<Cart> = {}): Cart {
  return {
    id: overrides.id ?? "cart_test",
    customerId: overrides.customerId ?? "cust_a",
    currency: overrides.currency ?? "IDR",
    status: overrides.status ?? "active",
    items: overrides.items ?? [
      {
        id: "ci_1",
        cartId: overrides.id ?? "cart_test",
        variantId: "var_1",
        quantity: 2,
        unitPrice: { amount: 250_000n, currency: "IDR" },
        lineTotal: { amount: 500_000n, currency: "IDR" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 86_400_000),
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function makeAddress(overrides: Partial<CustomerAddressRow> = {}): CustomerAddressRow {
  return {
    id: overrides.id ?? "adr_a",
    customerId: overrides.customerId ?? "cust_a",
    kind: overrides.kind ?? "shipping",
    isDefaultShipping: overrides.isDefaultShipping ?? true,
    isDefaultBilling: overrides.isDefaultBilling ?? false,
    recipientName: overrides.recipientName ?? "Budi",
    phone: overrides.phone ?? "+6281234567890",
    addressLine1: overrides.addressLine1 ?? "Jl. Mawar 1",
    addressLine2: overrides.addressLine2 ?? null,
    provinsiId: overrides.provinsiId ?? "31",
    kotaKabupatenId: overrides.kotaKabupatenId ?? "3171",
    kecamatanId: overrides.kecamatanId ?? "317101",
    kelurahanId: overrides.kelurahanId ?? null,
    postalCode: overrides.postalCode ?? "10110",
    notes: overrides.notes ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    deletedAt: overrides.deletedAt ?? null,
  };
}

function makeFakeCartService(carts: Map<string, Cart>): CartService {
  // Only the methods the checkout service uses are implemented; the rest
  // throw if reached, surfacing surprise dependencies as test failures.
  const fail = (): never => {
    throw new Error("not implemented in this fake");
  };
  return {
    async createGuestCart() {
      return fail();
    },
    async createCustomerCart() {
      return fail();
    },
    async getCartById(id) {
      return carts.get(id) ?? null;
    },
    async getActiveCartForCustomer() {
      return null;
    },
    async listCarts() {
      return fail();
    },
    async addItem() {
      return fail();
    },
    async updateItemQuantity() {
      return fail();
    },
    async removeItem() {
      return fail();
    },
    async clear() {
      return fail();
    },
    async mergeGuestIntoCustomer() {
      return fail();
    },
    async markAbandoned() {
      return fail();
    },
    getTotals(cart) {
      // Deterministic placeholder mirroring the real cart contract:
      // subtotal = sum of line totals; tax = 11%; shipping = 0.
      let subtotal = 0n;
      for (const item of cart.items) subtotal += item.lineTotal.amount;
      const tax = (subtotal * 11n) / 100n;
      return {
        subtotal: { amount: subtotal, currency: cart.currency },
        tax: { amount: tax, currency: cart.currency },
        shipping: { amount: 0n, currency: cart.currency },
        total: { amount: subtotal + tax, currency: cart.currency },
      };
    },
  };
}

function makeFakeCustomerService(
  addresses: Map<string, CustomerAddress>,
  customers: Map<string, Customer>,
): CustomerService {
  const fail = (): never => {
    throw new Error("not implemented in this fake");
  };
  return {
    async createCustomer() {
      return fail();
    },
    async getCustomerById(id) {
      return customers.get(id) ?? null;
    },
    async getCustomerByAuthUserId() {
      return null;
    },
    async getCustomerByEmail() {
      return null;
    },
    async listCustomers() {
      return fail();
    },
    async updateCustomer() {
      return fail();
    },
    async softDeleteCustomer() {
      return fail();
    },
    async getAddressById(id) {
      return addresses.get(id) ?? null;
    },
    async listAddresses() {
      return [];
    },
    async createAddress() {
      return fail();
    },
    async updateAddress() {
      return fail();
    },
    async deleteAddress() {
      return fail();
    },
    async setDefaultAddress() {
      return fail();
    },
    async listProvinsi() {
      return [];
    },
    async listKotaKabupaten() {
      return [];
    },
    async listKecamatan() {
      return [];
    },
    async listKelurahan() {
      return [];
    },
    async searchPostalCode() {
      return [];
    },
  };
}

/**
 * Minimal fake `ShippingService` for the checkout tests. Implements only
 * the surface the checkout calls: `quote()` and the lookups it uses for
 * validation. Returns a deterministic flat IDR rate by default; tests
 * needing the currency-mismatch path override `quote` to throw a
 * `ValidationError {code:"currency_mismatch"}`.
 */
interface FakeShippingOptions {
  /** Override the quote behavior for a specific test case. */
  quote?: ShippingService["quote"];
}

function makeFakeShippingService(opts: FakeShippingOptions = {}): ShippingService {
  const fail = (): never => {
    throw new Error("not implemented in this fake");
  };
  return {
    async listMethods() {
      return [];
    },
    async getById() {
      return null;
    },
    async getByCode(code) {
      if (code !== "flat" && code !== "MANUAL_FLAT") return null;
      return {
        id: "ship_flat",
        code,
        name: "Flat",
        providerKind: "manual",
        flatRate: { amount: 10_000n, currency: "IDR" },
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
    },
    quote:
      opts.quote ??
      (async ({ methodCode, currency }) => {
        if (methodCode !== "flat" && methodCode !== "MANUAL_FLAT") {
          throw new NotFoundError("Shipping method not found.", { methodCode });
        }
        // Default fake: flat rate fixed in IDR. A non-IDR request should
        // surface as a currency_mismatch ValidationError so tests that
        // probe that path see the expected error code.
        if (currency !== "IDR") {
          throw new ValidationError(
            "Shipping method currency does not match the requested currency.",
            {
              code: "currency_mismatch",
              methodCode,
              requestedCurrency: currency,
              methodCurrency: "IDR",
            },
          );
        }
        return { amount: 10_000n, currency: "IDR" };
      }),
    async createMethod() {
      return fail();
    },
    async updateMethod() {
      return fail();
    },
    async deleteMethod() {
      return fail();
    },
    async createFulfillment() {
      return fail();
    },
    registerPluginProvider() {
      // Plugin extension point — not exercised by the checkout fake.
    },
  };
}

function makeCustomerAddressDomain(row: CustomerAddressRow): CustomerAddress {
  return {
    id: row.id,
    customerId: row.customerId,
    kind: row.kind as "shipping" | "billing",
    isDefaultShipping: row.isDefaultShipping,
    isDefaultBilling: row.isDefaultBilling,
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    provinsiId: row.provinsiId,
    kotaKabupatenId: row.kotaKabupatenId,
    kecamatanId: row.kecamatanId,
    kelurahanId: row.kelurahanId,
    postalCode: row.postalCode,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

interface BuildResult {
  store: FakeStore;
  service: CheckoutServiceImpl;
  carts: Map<string, Cart>;
  addressesDomain: Map<string, CustomerAddress>;
  addressesRow: Map<string, CustomerAddressRow>;
  customers: Map<string, Customer>;
}

function buildService(repoOptions: FakeRepoOptions = {}): BuildResult {
  const store = createStore();
  const carts = new Map<string, Cart>();
  const addressesDomain = new Map<string, CustomerAddress>();
  const customers = new Map<string, Customer>();

  // Seed an active cart with one item.
  const cart = makeCart();
  carts.set(cart.id, cart);
  // Mirror the cart in the repo's snapshot store so `complete` can read it.
  store.carts.set(cart.id, {
    row: { id: cart.id, status: "active" },
    items: cart.items.map((it) => ({
      id: it.id,
      cartId: it.cartId,
      variantId: it.variantId,
      quantity: it.quantity,
      unitPriceAmount: it.unitPrice.amount,
      unitPriceCurrency: it.unitPrice.currency,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    })),
  });

  customers.set("cust_a", {
    id: "cust_a",
    authUserId: null,
    email: "buyer@example.com",
    displayName: "Buyer",
    phone: null,
    taxIdentifier: null,
    companyName: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  });

  // Seed addresses in both shapes (row store for snapshotting; domain
  // store for ownership checks).
  const shipping = makeAddress({ id: "adr_ship", customerId: "cust_a" });
  const billing = makeAddress({
    id: "adr_bill",
    customerId: "cust_a",
    kind: "billing",
  });
  store.addresses.set(shipping.id, shipping);
  store.addresses.set(billing.id, billing);
  addressesDomain.set(shipping.id, makeCustomerAddressDomain(shipping));
  addressesDomain.set(billing.id, makeCustomerAddressDomain(billing));

  // An address that belongs to a different customer — used to assert the
  // ownership guard.
  const foreign = makeAddress({ id: "adr_other", customerId: "cust_other" });
  store.addresses.set(foreign.id, foreign);
  addressesDomain.set(foreign.id, makeCustomerAddressDomain(foreign));

  const repo = createFakeRepo(store, repoOptions);
  const cartService = makeFakeCartService(carts);
  const customerService = makeFakeCustomerService(addressesDomain, customers);
  const shippingService = makeFakeShippingService();
  const service = new CheckoutServiceImpl(
    repo,
    cartService,
    customerService,
    shippingService,
  );

  return {
    store,
    service,
    carts,
    addressesDomain,
    addressesRow: store.addresses,
    customers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  events.clear();
});

describe("startCheckout", () => {
  it("creates a pending checkout from an active cart", async () => {
    const { service, store } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    expect(checkout.state).toBe("pending");
    expect(checkout.cartId).toBe("cart_test");
    expect(checkout.email).toBe("buyer@example.com");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.toState).toBe("pending");
    expect(store.events[0]!.fromState).toBeNull();
  });

  it("rejects a non-active cart with ConflictError", async () => {
    const { service, carts, store } = buildService();
    const cart = carts.get("cart_test")!;
    carts.set("cart_test", { ...cart, status: "abandoned" });
    store.carts.get("cart_test")!.row.status = "abandoned";
    await expect(service.startCheckout({ cartId: "cart_test" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("rejects an empty cart", async () => {
    const { service, carts } = buildService();
    const cart = carts.get("cart_test")!;
    carts.set("cart_test", { ...cart, items: [] });
    await expect(service.startCheckout({ cartId: "cart_test" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("requires email for guest carts (no customerId)", async () => {
    const { service, carts, store } = buildService();
    const cart = carts.get("cart_test")!;
    carts.set("cart_test", { ...cart, customerId: null });
    store.carts.get("cart_test")!.row.status = "active";
    await expect(service.startCheckout({ cartId: "cart_test" })).rejects.toThrow(
      /email is required/i,
    );
  });

  it("emits checkout.started", async () => {
    const { service } = buildService();
    let captured: { checkoutId: string; cartId: string } | null = null;
    events.on("checkout.started", (payload) => {
      captured = payload;
    });
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    expect(captured).not.toBeNull();
    expect(captured!.checkoutId).toBe(checkout.id);
    expect(captured!.cartId).toBe("cart_test");
  });
});

describe("setAddresses", () => {
  it("transitions pending → awaiting_shipping", async () => {
    const { service, store } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    const updated = await service.setAddresses(checkout.id, {
      shippingAddressId: "adr_ship",
      billingAddressId: "adr_bill",
    });
    expect(updated.state).toBe("awaiting_shipping");
    expect(updated.shippingAddressId).toBe("adr_ship");
    expect(updated.billingAddressId).toBe("adr_bill");
    expect(store.events).toHaveLength(2);
    expect(store.events[1]!.fromState).toBe("pending");
    expect(store.events[1]!.toState).toBe("awaiting_shipping");
  });

  it("rejects an address belonging to a different customer", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await expect(
      service.setAddresses(checkout.id, {
        shippingAddressId: "adr_other",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("permits revising the shipping address from awaiting_payment back to awaiting_shipping", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.setAddresses(checkout.id, { shippingAddressId: "adr_ship" });
    await service.setShipping(checkout.id, {
      shippingMethodCode: "flat",
    });
    // Re-set addresses — should bring us back to awaiting_shipping.
    const revised = await service.setAddresses(checkout.id, {
      shippingAddressId: "adr_bill",
    });
    expect(revised.state).toBe("awaiting_shipping");
    expect(revised.shippingAddressId).toBe("adr_bill");
  });
});

describe("setShipping", () => {
  it("transitions awaiting_shipping → awaiting_payment using the shipping module's quote", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.setAddresses(checkout.id, { shippingAddressId: "adr_ship" });
    const updated = await service.setShipping(checkout.id, {
      shippingMethodCode: "flat",
    });
    expect(updated.state).toBe("awaiting_payment");
    expect(updated.shippingMethodCode).toBe("flat");
    // The fake shipping service always returns 10_000 IDR for the
    // canonical "flat" code; checkout captures that on the row.
    expect(updated.shippingAmount?.amount).toBe(10_000n);
    expect(updated.shippingAmount?.currency).toBe("IDR");
  });

  it("rejects an unknown method code with NotFoundError", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.setAddresses(checkout.id, { shippingAddressId: "adr_ship" });
    await expect(
      service.setShipping(checkout.id, {
        shippingMethodCode: "DOES_NOT_EXIST",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("complete", () => {
  it("creates an order_intent, marks the cart converted, and transitions to completed", async () => {
    const { service, store } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.setAddresses(checkout.id, {
      shippingAddressId: "adr_ship",
      billingAddressId: "adr_bill",
    });
    await service.setShipping(checkout.id, {
      shippingMethodCode: "flat",
    });

    const captured: string[] = [];
    events.on("checkout.completed", (p) => {
      captured.push(p.checkoutId);
    });

    const result = await service.complete(checkout.id, {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "key-1",
    });

    expect(result.checkout.state).toBe("completed");
    expect(result.checkout.idempotencyKey).toBe("key-1");
    expect(result.checkout.paymentMethod).toBe("manual_bank_transfer");

    // Order intent has the right snapshot shape.
    expect(result.orderIntent.checkoutId).toBe(checkout.id);
    expect(result.orderIntent.email).toBe("buyer@example.com");
    expect(result.orderIntent.cartSnapshot).toHaveLength(1);
    expect(result.orderIntent.cartSnapshot[0]!.variantId).toBe("var_1");
    expect(result.orderIntent.cartSnapshot[0]!.quantity).toBe(2);
    expect(result.orderIntent.cartSnapshot[0]!.unitPrice.amount).toBe(250_000n);
    // Totals snapshot: subtotal 500k, tax 55k (11%), shipping 10k → 565k.
    expect(result.orderIntent.totalsSnapshot.total.amount).toBe(565_000n);
    expect(result.orderIntent.totalsSnapshot.shipping.amount).toBe(10_000n);

    expect(store.cartConverted.has("cart_test")).toBe(true);
    expect(captured).toContain(checkout.id);
  });

  it("rejects complete from a non-awaiting_payment state with invalid_transition", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await expect(
      service.complete(checkout.id, {
        paymentMethod: "manual_bank_transfer",
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("cancel", () => {
  it("moves a non-terminal state to failed with reason captured", async () => {
    const { service, store } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    const cancelled = await service.cancel(checkout.id, { reason: "changed mind" });
    expect(cancelled.state).toBe("failed");
    expect(cancelled.cancellationReason).toBe("changed mind");
    expect(store.events.at(-1)!.toState).toBe("failed");
  });

  it("refuses to cancel a terminal checkout", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.cancel(checkout.id, {});
    await expect(service.cancel(checkout.id, {})).rejects.toThrow(ConflictError);
  });
});

describe("listEvents", () => {
  it("returns the audit trail in order", async () => {
    const { service } = buildService();
    const checkout = await service.startCheckout({ cartId: "cart_test" });
    await service.setAddresses(checkout.id, { shippingAddressId: "adr_ship" });
    await service.setShipping(checkout.id, {
      shippingMethodCode: "flat",
    });
    const log = await service.listEvents(checkout.id);
    expect(log.map((e) => e.toState)).toEqual([
      "pending",
      "awaiting_shipping",
      "awaiting_payment",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and atomicity (B1, B2)
// ---------------------------------------------------------------------------

async function bringToAwaitingPayment(
  service: CheckoutServiceImpl,
): Promise<{ checkoutId: string }> {
  const checkout = await service.startCheckout({ cartId: "cart_test" });
  await service.setAddresses(checkout.id, { shippingAddressId: "adr_ship" });
  await service.setShipping(checkout.id, {
    shippingMethodCode: "flat",
  });
  return { checkoutId: checkout.id };
}

describe("complete — race resilience (B1)", () => {
  it("two concurrent complete() calls produce exactly one success and one already_completed", async () => {
    const { service } = buildService({ serializeTransactions: true });
    const { checkoutId } = await bringToAwaitingPayment(service);

    const a = service.complete(checkoutId, {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "key-a",
    });
    const b = service.complete(checkoutId, {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "key-b",
    });

    const settled = await Promise.allSettled([a, b]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.details.code).toBe("already_completed");
  });

  it("reclassifies a raw 23505 unique-violation as already_completed", async () => {
    const synthetic = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "order_intents_checkout_id_unique",
    });
    const { service } = buildService({ orderIntentInsertError: synthetic });
    const { checkoutId } = await bringToAwaitingPayment(service);

    await expect(
      service.complete(checkoutId, {
        paymentMethod: "manual_bank_transfer",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({
      details: { code: "already_completed" },
    });
  });
});

describe("events fire after commit, never on rollback (B2)", () => {
  it("events fire in declared order on success", async () => {
    const { service } = buildService();
    const fired: string[] = [];
    events.on("checkout.payment_initiated", () => {
      fired.push("checkout.payment_initiated");
    });
    events.on("checkout.completed", () => {
      fired.push("checkout.completed");
    });

    const { checkoutId } = await bringToAwaitingPayment(service);
    await service.complete(checkoutId, {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "key-1",
    });

    // payment_initiated comes before completed; nothing else fires.
    expect(fired).toEqual([
      "checkout.payment_initiated",
      "checkout.completed",
    ]);
  });

  it("no events fire when the transaction throws", async () => {
    const synthetic = new Error("simulated DB failure");
    const { service } = buildService({ orderIntentInsertError: synthetic });
    const fired: string[] = [];
    events.on("checkout.completed", () => {
      fired.push("checkout.completed");
    });
    events.on("checkout.payment_initiated", () => {
      fired.push("checkout.payment_initiated");
    });

    const { checkoutId } = await bringToAwaitingPayment(service);
    await expect(
      service.complete(checkoutId, {
        paymentMethod: "manual_bank_transfer",
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow();
    // The transaction threw — no post-commit events should have fired.
    expect(fired).toEqual([]);
  });
});

describe("complete — empty cart (S10)", () => {
  it("refuses with cart_empty when items were removed before completion", async () => {
    const { service, store, carts } = buildService();
    const { checkoutId } = await bringToAwaitingPayment(service);

    // Remove items from both the snapshot view and the live cart so
    // every code path sees an empty cart.
    const cartId = "cart_test";
    const cart = carts.get(cartId)!;
    carts.set(cartId, { ...cart, items: [] });
    const snapshot = store.carts.get(cartId)!;
    store.carts.set(cartId, { ...snapshot, items: [] });

    await expect(
      service.complete(checkoutId, {
        paymentMethod: "manual_bank_transfer",
        idempotencyKey: "key-empty",
      }),
    ).rejects.toMatchObject({ details: { code: "cart_empty" } });

    expect(store.cartConverted.has(cartId)).toBe(false);
    expect(store.orderIntents.size).toBe(0);
  });
});

describe("setAddresses — revision clears stale shipping (S11)", () => {
  it("clears shipping_method_code, shipping_amount, shipping_currency on revision", async () => {
    const { service } = buildService();
    const { checkoutId } = await bringToAwaitingPayment(service);
    // Revise back to awaiting_shipping by re-setting addresses.
    const revised = await service.setAddresses(checkoutId, {
      shippingAddressId: "adr_bill",
    });
    expect(revised.state).toBe("awaiting_shipping");
    expect(revised.shippingMethodCode).toBeNull();
    expect(revised.shippingAmount).toBeNull();
  });
});

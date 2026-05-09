/**
 * Cart routes — smoke tests over Hono's `app.request()`. Routers are built
 * with a fake `CartService` injected via the public route builders, so the
 * tests focus on:
 *
 *   1. The standard JSON envelope (success + error)
 *   2. Money serialization per ADR-0007 (string amount, ISO 4217 currency)
 *   3. Auth gating on the admin router (anonymous → 401, staff → 200)
 *   4. The customer auth path on `/customer/me/cart` — bearer token resolves
 *      to a customer through `customerService.getCustomerByAuthUserId`.
 *   5. `currency_mismatch` error shape from the service surfaces unchanged
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildCartAdminRoutes } from "../../../src/modules/cart/routes/admin.js";
import { buildCartStorefrontRoutes } from "../../../src/modules/cart/routes/storefront.js";
import { CartServiceImpl } from "../../../src/modules/cart/service.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  Cart,
  CartService,
  CartTotals,
  Paginated,
} from "../../../src/modules/cart/index.js";
import type {
  Customer,
  CustomerService,
} from "../../../src/modules/customer/index.js";
import { ValidationError } from "../../../src/lib/errors.js";

installBigIntJsonSerializer();

const NOW = new Date("2026-05-07T12:00:00.000Z");
const STAFF_USER = {
  id: "usr_staff",
  email: "staff@example.com",
  emailVerified: true,
  name: "Staff",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const CUSTOMER_USER = {
  id: "usr_customer",
  email: "buyer@example.com",
  emailVerified: true,
  name: "Buyer",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.spyOn(authService, "verifyApiKey").mockImplementation(async (bearer) => {
    if (bearer === "staff-key") {
      return {
        apiKey: {
          id: "apik_staff",
          userId: STAFF_USER.id,
          name: "test",
          scopes: ["catalog:read"],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: STAFF_USER,
      };
    }
    // Customer-side test bearer: maps to a non-staff auth_user. The
    // domain customer is resolved separately via
    // `customerService.getCustomerByAuthUserId` (mocked per-test).
    if (bearer === "customer-key") {
      return {
        apiKey: {
          id: "apik_customer",
          userId: CUSTOMER_USER.id,
          name: "test-customer",
          scopes: [],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: CUSTOMER_USER,
      };
    }
    return null;
  });
  vi.spyOn(authService, "getStaffProfile").mockImplementation(async (id) => {
    if (id !== STAFF_USER.id) return null;
    return {
      authUserId: STAFF_USER.id,
      role: "admin",
      displayName: "Staff",
      createdAt: NOW,
      updatedAt: NOW,
    };
  });
});

// ---------------------------------------------------------------------------
// Fake CartService factory
// ---------------------------------------------------------------------------

function makeCart(overrides: Partial<Cart> = {}): Cart {
  return {
    id: overrides.id ?? "cart_test",
    customerId: overrides.customerId ?? null,
    currency: overrides.currency ?? "IDR",
    status: overrides.status ?? "active",
    items: overrides.items ?? [],
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 86400000),
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

interface FakeOpts {
  initial?: Cart[];
  /** Override individual methods to inject specific behaviour. */
  overrides?: Partial<CartService>;
}

function createFakeService(opts: FakeOpts = {}): CartService {
  const carts = new Map<string, Cart>();
  for (const cart of opts.initial ?? []) carts.set(cart.id, cart);

  const fail = (): never => {
    throw new Error("not implemented in this test");
  };

  const baseTotals = (cart: Cart): CartTotals => ({
    subtotal: { amount: 0n, currency: cart.currency },
    tax: { amount: 0n, currency: cart.currency },
    shipping: { amount: 0n, currency: cart.currency },
    subtotalIncludingTax: { amount: 0n, currency: cart.currency },
    total: { amount: 0n, currency: cart.currency },
    taxRate: null,
  });

  const base: CartService = {
    async createGuestCart(currency) {
      const cart = makeCart({ id: "cart_new", currency });
      carts.set(cart.id, cart);
      return cart;
    },
    async createCustomerCart(customerId, currency) {
      const cart = makeCart({ id: "cart_cust_new", customerId, currency });
      carts.set(cart.id, cart);
      return cart;
    },
    async getCartById(id) {
      return carts.get(id) ?? null;
    },
    async getActiveCartForCustomer(customerId) {
      for (const cart of carts.values()) {
        if (cart.customerId === customerId && cart.status === "active") {
          return cart;
        }
      }
      return null;
    },
    async listCarts(query): Promise<Paginated<Cart>> {
      const all = [...carts.values()];
      return {
        data: all,
        total: all.length,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      };
    },
    async addItem(): Promise<Cart> {
      return fail();
    },
    async updateItemQuantity(): Promise<Cart> {
      return fail();
    },
    async removeItem(): Promise<Cart> {
      return fail();
    },
    async clear(): Promise<Cart> {
      return fail();
    },
    async mergeGuestIntoCustomer(): Promise<Cart> {
      return fail();
    },
    async markAbandoned(): Promise<Cart> {
      return fail();
    },
    getTotals(cart) {
      return baseTotals(cart);
    },
  };

  return { ...base, ...opts.overrides };
}

type TaxRateResolver = (
  currency: string,
) => Promise<{ code: string; rateBasisPoints: number } | null>;

/**
 * Build a minimal `CustomerService` stub for storefront tests. Only
 * `getCustomerByAuthUserId` is exercised by the cart routes — every
 * other method throws if called so a regression that adds a new
 * dependency surfaces loudly.
 */
function createFakeCustomerService(
  customers: Customer[] = [],
): CustomerService {
  const fail = (): never => {
    throw new Error("not implemented in this test");
  };
  return {
    async createCustomer(): Promise<Customer> {
      return fail();
    },
    async getCustomerById() {
      return null;
    },
    async getCustomerByAuthUserId(authUserId) {
      return customers.find((c) => c.authUserId === authUserId) ?? null;
    },
    async getCustomerByEmail() {
      return null;
    },
    async listCustomers() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async updateCustomer(): Promise<Customer> {
      return fail();
    },
    async softDeleteCustomer() {
      return;
    },
    async getAddressById() {
      return null;
    },
    async listAddresses() {
      return [];
    },
    async createAddress(): Promise<never> {
      return fail();
    },
    async updateAddress(): Promise<never> {
      return fail();
    },
    async deleteAddress() {
      return;
    },
    async setDefaultAddress(): Promise<never> {
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

function buildAdminApp(
  service: CartService,
  resolveTaxRate?: TaxRateResolver,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildCartAdminRoutes(service, resolveTaxRate));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(
  service: CartService,
  options: {
    customers?: CustomerService;
    resolveTaxRate?: TaxRateResolver;
  } = {},
): Hono<AppBindings> {
  const customers = options.customers ?? createFakeCustomerService();
  const app = new Hono<AppBindings>();
  app.route(
    "/storefront/v1",
    buildCartStorefrontRoutes(service, customers, options.resolveTaxRate),
  );
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storefront cart routes", () => {
  it("creates a cart and returns 201 with the wire envelope", async () => {
    const app = buildStorefrontApp(createFakeService());
    const res = await app.request("/storefront/v1/carts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: "IDR" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      currency: string;
      status: string;
      items: unknown[];
      totals: { subtotal: { amount: string; currency: string } };
    };
    expect(body.id).toBe("cart_new");
    expect(body.currency).toBe("IDR");
    expect(body.status).toBe("active");
    expect(body.items).toEqual([]);
    expect(body.totals.subtotal).toEqual({ amount: "0", currency: "IDR" });
  });

  it("returns 200 when adding an item, with totals embedded in the response", async () => {
    const cart = makeCart({
      items: [
        {
          id: "ci_1",
          cartId: "cart_test",
          variantId: "var_1",
          quantity: 2,
          unitPrice: { amount: 250_000n, currency: "IDR" },
          lineTotal: { amount: 500_000n, currency: "IDR" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const service = createFakeService({
      initial: [cart],
      overrides: {
        async addItem() {
          return cart;
        },
        getTotals() {
          return {
            subtotal: { amount: 500_000n, currency: "IDR" },
            tax: { amount: 55_000n, currency: "IDR" },
            shipping: { amount: 0n, currency: "IDR" },
            subtotalIncludingTax: { amount: 555_000n, currency: "IDR" },
            total: { amount: 555_000n, currency: "IDR" },
            taxRate: null,
          };
        },
      },
    });
    const app = buildStorefrontApp(service);
    const res = await app.request("/storefront/v1/carts/cart_test/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantId: "var_1", quantity: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ unitPrice: { amount: string; currency: string } }>;
      totals: { total: { amount: string; currency: string } };
    };
    expect(body.items[0]!.unitPrice).toEqual({
      amount: "250000",
      currency: "IDR",
    });
    expect(body.totals.total).toEqual({ amount: "555000", currency: "IDR" });
  });

  it("currency_mismatch from the service surfaces as the standard error envelope", async () => {
    const service = createFakeService({
      overrides: {
        async addItem() {
          throw new ValidationError(
            "Variant currency does not match the cart's currency.",
            {
              code: "currency_mismatch",
              cartCurrency: "IDR",
              variantCurrency: "USD",
              variantId: "var_usd",
            },
          );
        },
      },
    });
    const app = buildStorefrontApp(service);
    const res = await app.request("/storefront/v1/carts/cart_test/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variantId: "var_usd", quantity: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { code?: string } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.code).toBe("currency_mismatch");
  });

  it("returns the customer's active cart for the authenticated buyer", async () => {
    const cart = makeCart({
      id: "cart_for_cust",
      customerId: "cust_xyz",
    });
    const customer: Customer = {
      id: "cust_xyz",
      authUserId: CUSTOMER_USER.id,
      email: CUSTOMER_USER.email,
      displayName: CUSTOMER_USER.name,
      phone: null,
      taxIdentifier: null,
      companyName: null,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const app = buildStorefrontApp(createFakeService({ initial: [cart] }), {
      customers: createFakeCustomerService([customer]),
    });
    const res = await app.request("/storefront/v1/customer/me/cart", {
      headers: { authorization: "Bearer customer-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; customerId: string };
    expect(body.id).toBe("cart_for_cust");
    expect(body.customerId).toBe("cust_xyz");
  });

  it("rejects /customer/me/cart with no auth (401)", async () => {
    const app = buildStorefrontApp(createFakeService());
    const res = await app.request("/storefront/v1/customer/me/cart");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 404 customer_not_provisioned when the auth_user has no customer row", async () => {
    const app = buildStorefrontApp(createFakeService(), {
      // no customer for CUSTOMER_USER.id
      customers: createFakeCustomerService([]),
    });
    const res = await app.request("/storefront/v1/customer/me/cart", {
      headers: { authorization: "Bearer customer-key" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { details: { code: string } } };
    expect(body.error.details.code).toBe("customer_not_provisioned");
  });

  it("populates the new tax fields on the wire shape when the resolver returns a rate", async () => {
    // Replace the fake service's getTotals with the real one so the
    // route's `await totalsFor(cart)` flows the resolved rate end-to-end
    // through getTotals → toWireCart, exactly as production does.
    const realService = new CartServiceImpl({} as never) as CartService;

    const cart = makeCart({
      id: "cart_with_items",
      items: [
        {
          id: "ci_1",
          cartId: "cart_with_items",
          variantId: "var_1",
          quantity: 1,
          unitPrice: { amount: 100_000n, currency: "IDR" },
          lineTotal: { amount: 100_000n, currency: "IDR" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const service: CartService = {
      ...createFakeService({ initial: [cart] }),
      getTotals: realService.getTotals.bind(realService),
    };
    const app = buildStorefrontApp(service, {
      resolveTaxRate: async (currency) => {
        // Simulate the production resolver bound to
        // taxService.getDefaultRate.
        if (currency === "IDR")
          return { code: "PPN_11", rateBasisPoints: 1100 };
        return null;
      },
    });

    const res = await app.request("/storefront/v1/carts/cart_with_items");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        subtotal: { amount: string; currency: string };
        tax: { amount: string; currency: string };
        shipping: { amount: string; currency: string };
        subtotalIncludingTax: { amount: string; currency: string };
        total: { amount: string; currency: string };
        taxRate: { code: string; basisPoints: number } | null;
        taxRateCode: string | null;
        taxRateBasisPoints: number | null;
      };
    };
    // 100_000 × 11% = 11_000 → subtotalIncludingTax = 111_000.
    expect(body.totals.subtotal.amount).toBe("100000");
    expect(body.totals.tax.amount).toBe("11000");
    expect(body.totals.subtotalIncludingTax.amount).toBe("111000");
    expect(body.totals.shipping.amount).toBe("0");
    expect(body.totals.total.amount).toBe("111000");
    // Both shapes (nested + flat) are populated together.
    expect(body.totals.taxRate).toEqual({ code: "PPN_11", basisPoints: 1100 });
    expect(body.totals.taxRateCode).toBe("PPN_11");
    expect(body.totals.taxRateBasisPoints).toBe(1100);
  });

  it("falls back to env-var tax (taxRate fields null) when the resolver returns null", async () => {
    const realService = new CartServiceImpl({} as never) as CartService;

    const cart = makeCart({
      id: "cart_no_rate",
      items: [
        {
          id: "ci_1",
          cartId: "cart_no_rate",
          variantId: "var_1",
          quantity: 1,
          unitPrice: { amount: 100_000n, currency: "IDR" },
          lineTotal: { amount: 100_000n, currency: "IDR" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    const service: CartService = {
      ...createFakeService({ initial: [cart] }),
      getTotals: realService.getTotals.bind(realService),
    };
    // Resolver returns null → cart falls back to env.taxPpnRate (0.11
    // in the vitest environment) but reports `taxRate: null` on the wire
    // since no module-supplied rate was actually applied.
    const app = buildStorefrontApp(service, {
      resolveTaxRate: async () => null,
    });

    const res = await app.request("/storefront/v1/carts/cart_no_rate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        subtotalIncludingTax: { amount: string; currency: string };
        taxRate: unknown;
        taxRateCode: string | null;
        taxRateBasisPoints: number | null;
      };
    };
    expect(body.totals.subtotalIncludingTax.amount).toBe("111000");
    expect(body.totals.taxRate).toBeNull();
    expect(body.totals.taxRateCode).toBeNull();
    expect(body.totals.taxRateBasisPoints).toBeNull();
  });
});

describe("admin cart routes", () => {
  it("rejects an anonymous list request with 401", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/carts");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("admits an admin caller and returns the standard pagination envelope", async () => {
    const cart = makeCart({ id: "cart_a", customerId: "cust_a" });
    const app = buildAdminApp(createFakeService({ initial: [cart] }));
    const res = await app.request("/admin/v1/carts", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; totals: unknown }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.data[0]!.id).toBe("cart_a");
    // Each row carries an embedded `totals` block (computed via getTotals).
    expect(body.data[0]!.totals).toBeDefined();
  });
});

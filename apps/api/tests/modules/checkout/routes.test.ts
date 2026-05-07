/**
 * Checkout routes — smoke tests over Hono's `app.request()`.
 *
 * Mirrors the cart routes test pattern: routers are built with a fake
 * `CheckoutService` injected via the public route builders. The
 * idempotency middleware accepts an injected `IdempotencyStore`, so the
 * tests run without a database.
 *
 * Coverage:
 *   1. Happy path: start → setAddresses → setShipping → complete (with
 *      Idempotency-Key) → 200 with order_intent in the response.
 *   2. Replay of `complete` with the same idempotency key returns the
 *      identical response and runs the underlying service ONCE.
 *   3. Admin list with an authenticated staff caller; anonymous → 401.
 *   4. Cancel from a non-terminal state returns 200 with state=failed.
 *   5. Service-thrown ConflictError surfaces as the standard envelope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildCheckoutAdminRoutes } from "../../../src/modules/checkout/routes/admin.js";
import { buildCheckoutStorefrontRoutes } from "../../../src/modules/checkout/routes/storefront.js";
import {
  IDEMPOTENCY_STATUS_IN_FLIGHT,
  type ClaimResult,
  type IdempotencyStore,
} from "../../../src/middleware/idempotency.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  Checkout,
  CheckoutEvent,
  CheckoutService,
  CompleteCheckoutResult,
  OrderIntent,
  Paginated,
} from "../../../src/modules/checkout/index.js";
import { ConflictError } from "../../../src/lib/errors.js";

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

beforeEach(() => {
  vi.spyOn(authService, "verifyApiKey").mockImplementation(async (bearer) => {
    if (bearer !== "staff-key") return null;
    return {
      apiKey: {
        id: "apik_staff",
        userId: STAFF_USER.id,
        name: "test",
        scopes: [],
        lastUsedAt: null,
        createdAt: NOW,
        revokedAt: null,
      },
      user: STAFF_USER,
    };
  });
  vi.spyOn(authService, "getStaffProfile").mockImplementation(async (userId) => {
    if (userId !== STAFF_USER.id) return null;
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
// Fake service + idempotency store
// ---------------------------------------------------------------------------

function makeCheckout(overrides: Partial<Checkout> = {}): Checkout {
  return {
    id: overrides.id ?? "chk_test",
    cartId: overrides.cartId ?? "cart_test",
    customerId: overrides.customerId ?? "cust_a",
    state: overrides.state ?? "pending",
    shippingAddressId: overrides.shippingAddressId ?? null,
    billingAddressId: overrides.billingAddressId ?? null,
    email: overrides.email ?? "buyer@example.com",
    shippingMethodCode: overrides.shippingMethodCode ?? null,
    shippingAmount: overrides.shippingAmount ?? null,
    paymentMethod: overrides.paymentMethod ?? null,
    cancellationReason: overrides.cancellationReason ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 3_600_000),
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function makeOrderIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: overrides.id ?? "oint_1",
    checkoutId: overrides.checkoutId ?? "chk_test",
    cartSnapshot: overrides.cartSnapshot ?? [
      {
        variantId: "var_1",
        quantity: 2,
        unitPrice: { amount: 250_000n, currency: "IDR" },
      },
    ],
    totalsSnapshot: overrides.totalsSnapshot ?? {
      subtotal: { amount: 500_000n, currency: "IDR" },
      tax: { amount: 55_000n, currency: "IDR" },
      shipping: { amount: 10_000n, currency: "IDR" },
      total: { amount: 565_000n, currency: "IDR" },
    },
    shippingAddressSnapshot: overrides.shippingAddressSnapshot ?? {
      id: "adr_ship",
      customerId: "cust_a",
      kind: "shipping",
      recipientName: "Budi",
      phone: "+6281234567890",
      addressLine1: "Jl. Mawar 1",
      addressLine2: null,
      provinsiId: "31",
      kotaKabupatenId: "3171",
      kecamatanId: "317101",
      kelurahanId: null,
      postalCode: "10110",
      notes: null,
    },
    billingAddressSnapshot: overrides.billingAddressSnapshot ?? null,
    email: overrides.email ?? "buyer@example.com",
    shippingMethodCode: overrides.shippingMethodCode ?? "flat",
    paymentMethod: overrides.paymentMethod ?? "manual_bank_transfer",
    createdAt: overrides.createdAt ?? NOW,
  };
}

interface FakeOpts {
  initial?: Checkout[];
  overrides?: Partial<CheckoutService>;
}

function createFakeService(opts: FakeOpts = {}): {
  service: CheckoutService;
  completeCalls: number;
} {
  const checkouts = new Map<string, Checkout>();
  for (const c of opts.initial ?? []) checkouts.set(c.id, c);
  let completeCalls = 0;

  const fail = (): never => {
    throw new Error("not implemented in this test");
  };

  const base: CheckoutService = {
    async startCheckout(input) {
      const checkout = makeCheckout({
        id: "chk_new",
        cartId: input.cartId,
        email: input.email ?? "buyer@example.com",
      });
      checkouts.set(checkout.id, checkout);
      return checkout;
    },
    async getCheckout(id) {
      return checkouts.get(id) ?? null;
    },
    async setAddresses(id, input) {
      const existing = checkouts.get(id) ?? makeCheckout({ id });
      const updated: Checkout = {
        ...existing,
        state: "awaiting_shipping",
        shippingAddressId: input.shippingAddressId,
        billingAddressId: input.billingAddressId ?? null,
      };
      checkouts.set(id, updated);
      return updated;
    },
    async setShipping(id, input) {
      // The route layer no longer passes a client-supplied amount —
      // the service resolves the amount via the shipping module.
      // For the route smoke test we pin a fixed amount so the wire
      // shape assertions stay deterministic; the resolution path is
      // covered separately in the service test.
      const existing = checkouts.get(id) ?? makeCheckout({ id });
      const updated: Checkout = {
        ...existing,
        state: "awaiting_payment",
        shippingMethodCode: input.shippingMethodCode,
        shippingAmount: { amount: 15_000n, currency: existing.shippingAmount?.currency ?? "IDR" },
      };
      checkouts.set(id, updated);
      return updated;
    },
    async complete(id, input): Promise<CompleteCheckoutResult> {
      completeCalls += 1;
      const existing = checkouts.get(id) ?? makeCheckout({ id });
      const updated: Checkout = {
        ...existing,
        state: "completed",
        paymentMethod: input.paymentMethod,
        idempotencyKey: input.idempotencyKey,
      };
      checkouts.set(id, updated);
      return { checkout: updated, orderIntent: makeOrderIntent({ checkoutId: id }) };
    },
    async cancel(id, input) {
      const existing = checkouts.get(id) ?? makeCheckout({ id });
      const updated: Checkout = {
        ...existing,
        state: "failed",
        cancellationReason: input.reason ?? null,
      };
      checkouts.set(id, updated);
      return updated;
    },
    async listCheckouts(query): Promise<Paginated<Checkout>> {
      const all = [...checkouts.values()];
      return {
        data: all,
        total: all.length,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      };
    },
    async listEvents(): Promise<CheckoutEvent[]> {
      return fail();
    },
  };

  return {
    service: { ...base, ...opts.overrides },
    get completeCalls() {
      return completeCalls;
    },
  } as unknown as { service: CheckoutService; completeCalls: number };
}

function createMemoryStore(): IdempotencyStore {
  const map = new Map<
    string,
    { requestHash: string; status: number; body: unknown }
  >();
  return {
    async claim(key, requestHash): Promise<ClaimResult> {
      if (!map.has(key)) {
        map.set(key, {
          requestHash,
          status: IDEMPOTENCY_STATUS_IN_FLIGHT,
          body: null,
        });
        return { kind: "claimed" };
      }
      return { kind: "existing", record: { ...map.get(key)! } };
    },
    async get(key) {
      const row = map.get(key);
      return row ? { ...row } : null;
    },
    async finalize(key, requestHash, status, body) {
      const existing = map.get(key);
      if (!existing) return;
      if (existing.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return;
      map.set(key, { requestHash, status, body });
    },
    async releaseInFlight(key) {
      const existing = map.get(key);
      if (!existing) return;
      if (existing.status !== IDEMPOTENCY_STATUS_IN_FLIGHT) return;
      map.delete(key);
    },
  };
}

function buildStorefrontApp(
  service: CheckoutService,
  store: IdempotencyStore,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route(
    "/storefront/v1",
    buildCheckoutStorefrontRoutes(service, { idempotencyStore: store }),
  );
  app.onError(errorHandler);
  return app;
}

function buildAdminApp(service: CheckoutService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildCheckoutAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storefront checkout — happy path", () => {
  it("walks start → setAddresses → setShipping → complete (with Idempotency-Key)", async () => {
    const fake = createFakeService();
    const store = createMemoryStore();
    const app = buildStorefrontApp(fake.service, store);

    // 1. Start
    const startRes = await app.request("/storefront/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartId: "cart_test" }),
    });
    expect(startRes.status).toBe(201);
    const startBody = (await startRes.json()) as { id: string; state: string };
    expect(startBody.state).toBe("pending");

    // 2. Set addresses
    const addrRes = await app.request(
      `/storefront/v1/checkouts/${startBody.id}/addresses`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shippingAddressId: "adr_ship" }),
      },
    );
    expect(addrRes.status).toBe(200);
    const addrBody = (await addrRes.json()) as { state: string };
    expect(addrBody.state).toBe("awaiting_shipping");

    // 3. Set shipping — body carries only the method code; the server
    // resolves the amount via the shipping module's quote().
    const shipRes = await app.request(
      `/storefront/v1/checkouts/${startBody.id}/shipping`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shippingMethodCode: "flat",
        }),
      },
    );
    expect(shipRes.status).toBe(200);
    const shipBody = (await shipRes.json()) as {
      state: string;
      shippingAmount: { amount: string; currency: string };
    };
    expect(shipBody.state).toBe("awaiting_payment");
    // The fake service in this test pins the amount to 15_000 IDR (see
    // setShipping in createFakeService).
    expect(shipBody.shippingAmount).toEqual({ amount: "15000", currency: "IDR" });

    // 4. Complete (with Idempotency-Key)
    const compRes = await app.request(
      `/storefront/v1/checkouts/${startBody.id}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "complete-key-1",
        },
        body: JSON.stringify({ paymentMethod: "manual_bank_transfer" }),
      },
    );
    expect(compRes.status).toBe(200);
    const compBody = (await compRes.json()) as {
      checkout: { state: string; idempotencyKey: string };
      orderIntent: { id: string; totalsSnapshot: { total: { amount: string; currency: string } } };
    };
    expect(compBody.checkout.state).toBe("completed");
    expect(compBody.checkout.idempotencyKey).toBe("complete-key-1");
    expect(compBody.orderIntent.id).toBe("oint_1");
    expect(compBody.orderIntent.totalsSnapshot.total).toEqual({
      amount: "565000",
      currency: "IDR",
    });
  });
});

describe("storefront checkout — idempotency replay", () => {
  it("returns the identical response and triggers the underlying service ONCE", async () => {
    const fake = createFakeService({
      initial: [
        makeCheckout({
          id: "chk_x",
          state: "awaiting_payment",
          shippingAddressId: "adr_ship",
          shippingMethodCode: "flat",
          shippingAmount: { amount: 10_000n, currency: "IDR" },
        }),
      ],
    });
    const store = createMemoryStore();
    const app = buildStorefrontApp(fake.service, store);

    const opts = {
      method: "POST" as const,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "key-replay",
      },
      body: JSON.stringify({ paymentMethod: "manual_bank_transfer" }),
    };

    const first = await app.request("/storefront/v1/checkouts/chk_x/complete", opts);
    const firstBody = await first.json();
    expect(first.status).toBe(200);

    const second = await app.request("/storefront/v1/checkouts/chk_x/complete", opts);
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(fake.completeCalls).toBe(1);
  });
});

describe("storefront checkout — cancel", () => {
  it("transitions a non-terminal checkout to failed", async () => {
    const fake = createFakeService({
      initial: [makeCheckout({ id: "chk_z", state: "pending" })],
    });
    const store = createMemoryStore();
    const app = buildStorefrontApp(fake.service, store);
    const res = await app.request("/storefront/v1/checkouts/chk_z/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "user changed mind" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      cancellationReason: string;
    };
    expect(body.state).toBe("failed");
    expect(body.cancellationReason).toBe("user changed mind");
  });
});

describe("storefront checkout — error envelopes", () => {
  it("surfaces a service ConflictError as the standard error shape", async () => {
    const fake = createFakeService({
      overrides: {
        async setAddresses() {
          throw new ConflictError("Addresses cannot be changed in this state.", {
            code: "invalid_transition",
            from: "completed",
            to: "awaiting_shipping",
          });
        },
      },
    });
    const store = createMemoryStore();
    const app = buildStorefrontApp(fake.service, store);
    const res = await app.request("/storefront/v1/checkouts/chk_test/addresses", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shippingAddressId: "adr_ship" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { code?: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.code).toBe("invalid_transition");
  });
});

describe("admin checkout routes", () => {
  it("rejects an anonymous list request with 401", async () => {
    const fake = createFakeService();
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/checkouts");
    expect(res.status).toBe(401);
  });

  it("admits an authenticated staff caller and returns the standard pagination envelope", async () => {
    const fake = createFakeService({
      initial: [makeCheckout({ id: "chk_a" })],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/checkouts", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; state: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]!.id).toBe("chk_a");
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
  });
});

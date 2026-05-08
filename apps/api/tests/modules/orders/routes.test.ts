/**
 * Orders routes — smoke tests over Hono's `app.request()`.
 *
 * Mirrors the checkout routes test pattern: routers are built with a fake
 * `OrderService` injected via the public route builders. Auth is faked
 * by spying on `authService.verifyApiKey` / `authService.getStaffProfile`
 * so the admin gate accepts a `Bearer staff-key`.
 *
 * Coverage:
 *   1. Admin list — anonymous → 401; staff → standard pagination envelope.
 *   2. Admin detail — 404 surfaces as the standard error envelope.
 *   3. Admin transition — service ConflictError surfaces as 409.
 *   4. Admin cancel — staff actor captured; reason forwarded.
 *   5. Storefront /me/orders — header-less call → 401.
 *   6. Storefront /me/orders/:orderNumber — cross-customer → 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildOrdersAdminRoutes } from "../../../src/modules/orders/routes/admin.js";
import { buildOrdersStorefrontRoutes } from "../../../src/modules/orders/routes/storefront.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  Order,
  OrderService,
  OrderStatusEvent,
  Paginated,
} from "../../../src/modules/orders/index.js";
import { ConflictError, NotFoundError } from "../../../src/lib/errors.js";

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
  vi.spyOn(authService, "getStaffProfile").mockImplementation(
    async (userId) => {
      if (userId !== STAFF_USER.id) return null;
      return {
        authUserId: STAFF_USER.id,
        role: "admin",
        displayName: "Staff",
        createdAt: NOW,
        updatedAt: NOW,
      };
    },
  );
});

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? "ord_test",
    orderNumber: overrides.orderNumber ?? "ORD-2026-000100",
    customerId: overrides.customerId ?? "cust_a",
    email: overrides.email ?? "buyer@example.com",
    currency: overrides.currency ?? "IDR",
    status: overrides.status ?? "pending_payment",
    subtotal: overrides.subtotal ?? { amount: 500_000n, currency: "IDR" },
    tax: overrides.tax ?? { amount: 55_000n, currency: "IDR" },
    taxRateCode: overrides.taxRateCode ?? null,
    taxRateBasisPoints: overrides.taxRateBasisPoints ?? null,
    shipping: overrides.shipping ?? { amount: 10_000n, currency: "IDR" },
    shippingMethodCode: overrides.shippingMethodCode ?? "flat",
    total: overrides.total ?? { amount: 565_000n, currency: "IDR" },
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
    paymentMethod: overrides.paymentMethod ?? "manual_bank_transfer",
    items: overrides.items ?? [],
    paidAt: overrides.paidAt ?? null,
    fulfilledAt: overrides.fulfilledAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    refundedAt: overrides.refundedAt ?? null,
    cancellationReason: overrides.cancellationReason ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

interface FakeOpts {
  orders?: Order[];
  events?: OrderStatusEvent[];
  overrides?: Partial<OrderService>;
}

function createFakeService(opts: FakeOpts = {}): {
  service: OrderService;
  cancelCalls: Array<{ id: string; reason: string | null; actorId: string | null }>;
  transitionCalls: Array<{ id: string; toStatus: string; actorId: string | null }>;
} {
  const orders = new Map<string, Order>();
  for (const o of opts.orders ?? []) orders.set(o.id, o);
  const cancelCalls: Array<{
    id: string;
    reason: string | null;
    actorId: string | null;
  }> = [];
  const transitionCalls: Array<{
    id: string;
    toStatus: string;
    actorId: string | null;
  }> = [];

  const fail = (): never => {
    throw new Error("not implemented in this test");
  };

  const base: OrderService = {
    async createFromIntent() {
      return fail();
    },
    async getOrderById(id) {
      return orders.get(id) ?? null;
    },
    async getOrderByNumber(orderNumber) {
      for (const o of orders.values()) {
        if (o.orderNumber === orderNumber) return o;
      }
      return null;
    },
    async listOrders(query): Promise<Paginated<Order>> {
      let all = [...orders.values()];
      if (query.status) all = all.filter((o) => o.status === query.status);
      if (query.email) all = all.filter((o) => o.email === query.email);
      if (query.orderNumber)
        all = all.filter((o) => o.orderNumber === query.orderNumber);
      return {
        data: all,
        total: all.length,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      };
    },
    async listCustomerOrders(customerId, query) {
      const all = [...orders.values()].filter(
        (o) => o.customerId === customerId,
      );
      return {
        data: all,
        total: all.length,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
      };
    },
    async transitionStatus(id, toStatus, opts) {
      transitionCalls.push({
        id,
        toStatus,
        actorId: opts.actorId ?? null,
      });
      const existing = orders.get(id) ?? makeOrder({ id });
      const updated: Order = { ...existing, status: toStatus };
      orders.set(id, updated);
      return updated;
    },
    async cancelOrder(id, opts) {
      cancelCalls.push({
        id,
        reason: opts.reason ?? null,
        actorId: opts.actorId ?? null,
      });
      const existing = orders.get(id) ?? makeOrder({ id });
      const updated: Order = {
        ...existing,
        status: "cancelled",
        cancellationReason: opts.reason ?? null,
        cancelledAt: NOW,
      };
      orders.set(id, updated);
      return updated;
    },
    async listStatusHistory(orderId) {
      if (!orders.has(orderId)) {
        throw new NotFoundError("Order not found.", { orderId });
      }
      return opts.events ?? [];
    },
  };

  return {
    service: { ...base, ...opts.overrides },
    cancelCalls,
    transitionCalls,
  };
}

function buildAdminApp(service: OrderService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildOrdersAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(service: OrderService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/storefront/v1", buildOrdersStorefrontRoutes(service));
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

describe("admin orders — list", () => {
  it("rejects an anonymous list request with 401", async () => {
    const fake = createFakeService();
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders");
    expect(res.status).toBe(401);
  });

  it("admits an authenticated staff caller and returns the standard pagination envelope", async () => {
    const fake = createFakeService({ orders: [makeOrder({ id: "ord_a" })] });
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string; total: { amount: string } }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]!.id).toBe("ord_a");
    expect(body.data[0]!.status).toBe("pending_payment");
    expect(body.data[0]!.total.amount).toBe("565000");
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
  });

  it("filters by exact orderNumber when ?orderNumber= is set", async () => {
    const fake = createFakeService({
      orders: [
        makeOrder({ id: "ord_a", orderNumber: "ORD-2026-000100" }),
        makeOrder({
          id: "ord_b",
          orderNumber: "ORD-2026-000200",
          email: "other@example.com",
        }),
      ],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request(
      "/admin/v1/orders?orderNumber=ORD-2026-000200",
      { headers: { authorization: "Bearer staff-key" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; orderNumber: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.orderNumber).toBe("ORD-2026-000200");
  });

  it("returns an empty page when ?orderNumber= matches nothing", async () => {
    const fake = createFakeService({
      orders: [makeOrder({ id: "ord_a", orderNumber: "ORD-2026-000100" })],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request(
      "/admin/v1/orders?orderNumber=ORD-2026-999999",
      { headers: { authorization: "Bearer staff-key" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.data).toEqual([]);
  });

  it("normalises an orderNumber filter to upper-case, trimmed", async () => {
    const fake = createFakeService({
      orders: [makeOrder({ id: "ord_a", orderNumber: "ORD-2026-000100" })],
    });
    const app = buildAdminApp(fake.service);
    // Lower-case + extra whitespace from URL-encoded input — the Zod
    // transform on the route should fold it to the canonical handle.
    const res = await app.request(
      `/admin/v1/orders?orderNumber=${encodeURIComponent("  ord-2026-000100  ")}`,
      { headers: { authorization: "Bearer staff-key" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it("composes orderNumber with status (both filters apply)", async () => {
    const fake = createFakeService({
      orders: [
        makeOrder({
          id: "ord_a",
          orderNumber: "ORD-2026-000100",
          status: "paid",
        }),
        makeOrder({
          id: "ord_b",
          orderNumber: "ORD-2026-000100", // same number, different status — synthetic
          status: "pending_payment",
        }),
      ],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request(
      "/admin/v1/orders?orderNumber=ORD-2026-000100&status=paid",
      { headers: { authorization: "Bearer staff-key" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]!.id).toBe("ord_a");
    expect(body.data[0]!.status).toBe("paid");
  });

  it("treats an empty ?orderNumber= as no filter", async () => {
    const fake = createFakeService({
      orders: [
        makeOrder({ id: "ord_a", orderNumber: "ORD-2026-000100" }),
        makeOrder({ id: "ord_b", orderNumber: "ORD-2026-000200" }),
      ],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders?orderNumber=", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(2);
  });
});

describe("admin orders — detail and transitions", () => {
  it("returns the standard error envelope for a missing order", async () => {
    const fake = createFakeService();
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders/ord_missing", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("forwards a service ConflictError on invalid transition as a 409 envelope", async () => {
    const fake = createFakeService({
      orders: [makeOrder({ id: "ord_a" })],
      overrides: {
        async transitionStatus() {
          throw new ConflictError("Invalid order status transition.", {
            code: "invalid_transition",
            from: "pending_payment",
            to: "fulfilled",
          });
        },
      },
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders/ord_a/transition", {
      method: "POST",
      headers: {
        authorization: "Bearer staff-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ toStatus: "fulfilled" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { code?: string } };
    };
    expect(body.error.code).toBe("conflict");
    expect(body.error.details.code).toBe("invalid_transition");
  });

  it("captures the staff actor on a successful cancel and forwards the reason", async () => {
    const fake = createFakeService({
      orders: [makeOrder({ id: "ord_a" })],
    });
    const app = buildAdminApp(fake.service);
    const res = await app.request("/admin/v1/orders/ord_a/cancel", {
      method: "POST",
      headers: {
        authorization: "Bearer staff-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "duplicate" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      cancellationReason: string;
    };
    expect(body.status).toBe("cancelled");
    expect(body.cancellationReason).toBe("duplicate");
    expect(fake.cancelCalls).toEqual([
      { id: "ord_a", reason: "duplicate", actorId: STAFF_USER.id },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Storefront routes
// ---------------------------------------------------------------------------

describe("storefront orders — me/orders", () => {
  it("rejects a request without the x-customer-id header", async () => {
    const fake = createFakeService();
    const app = buildStorefrontApp(fake.service);
    const res = await app.request("/storefront/v1/customer/me/orders");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an order that belongs to a different customer (no existence leak)", async () => {
    const fake = createFakeService({
      orders: [
        makeOrder({
          id: "ord_a",
          orderNumber: "ORD-2026-000100",
          customerId: "cust_owner",
        }),
      ],
    });
    const app = buildStorefrontApp(fake.service);
    const res = await app.request(
      "/storefront/v1/customer/me/orders/ORD-2026-000100",
      { headers: { "x-customer-id": "cust_stranger" } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

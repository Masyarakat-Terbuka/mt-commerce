/**
 * Shipping fulfillment admin routes — smoke tests.
 *
 * Covers the cross-module composition: when a fulfillment is marked
 * delivered, the route layer must also nudge the parent order to
 * `fulfilled`. We assert that the orders service is called, and that an
 * invalid order transition is swallowed (the fulfillment write must
 * still surface as success).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildShippingAdminFulfillmentRoutes } from "../../../src/modules/shipping/routes/admin-fulfillments.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  Fulfillment,
  ShippingService,
} from "../../../src/modules/shipping/index.js";
import type { Order, OrderService } from "../../../src/modules/orders/index.js";
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

function makeFulfillment(overrides: Partial<Fulfillment> = {}): Fulfillment {
  return {
    id: overrides.id ?? "ful_a",
    orderId: overrides.orderId ?? "ord_a",
    shippingMethodId: overrides.shippingMethodId ?? "ship_a",
    status: overrides.status ?? "pending",
    trackingCode: overrides.trackingCode ?? null,
    trackedAt: overrides.trackedAt ?? null,
    deliveredAt: overrides.deliveredAt ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function makeShippingService(
  overrides: Partial<ShippingService> = {},
): ShippingService {
  const fail = (): never => {
    throw new Error("not implemented in this test");
  };
  return {
    listMethods: async () => [],
    getById: async () => null,
    getByCode: async () => null,
    quote: async () => fail(),
    createMethod: async () => fail(),
    updateMethod: async () => fail(),
    deleteMethod: async () => fail(),
    getFulfillmentById: async () => null,
    listFulfillmentsByOrderId: async () => [],
    listFulfillmentsForOrders: async () => [],
    createFulfillmentForOrder: async () => fail(),
    setTracking: async () => fail(),
    markShipped: async () => fail(),
    markDelivered: async () => fail(),
    cancel: async () => fail(),
    registerPluginProvider: () => {
      // Plugin extension point — not exercised by this test.
    },
    ...overrides,
  };
}

function makeOrderService(
  overrides: Partial<OrderService> = {},
): OrderService {
  const fail = (): never => {
    throw new Error("not implemented in this test");
  };
  return {
    createFromIntent: async () => fail(),
    getOrderById: async () => null,
    getOrderByNumber: async () => null,
    getOrderByCheckoutId: async () => null,
    listOrders: async () => ({ data: [], total: 0, page: 1, pageSize: 20 }),
    listCustomerOrders: async () => ({
      data: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    transitionStatus: async () => fail() as unknown as Order,
    cancelOrder: async () => fail() as unknown as Order,
    listStatusHistory: async () => [],
    ...overrides,
  };
}

function buildApp(
  shipping: ShippingService,
  orders: OrderService,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildShippingAdminFulfillmentRoutes(shipping, orders));
  app.onError(errorHandler);
  return app;
}

const STAFF_HEADERS = { Authorization: "Bearer staff-key" } as const;

describe("admin fulfillment routes", () => {
  it("rejects anonymous callers with 401", async () => {
    const app = buildApp(makeShippingService(), makeOrderService());
    const res = await app.request("/admin/v1/fulfillments?orderId=ord_a");
    expect(res.status).toBe(401);
  });

  it("GET /fulfillments?orderId returns the wrapped list", async () => {
    const f = makeFulfillment({ status: "pending" });
    const app = buildApp(
      makeShippingService({
        async listFulfillmentsByOrderId(orderId) {
          expect(orderId).toBe("ord_a");
          return [f];
        },
      }),
      makeOrderService(),
    );
    const res = await app.request("/admin/v1/fulfillments?orderId=ord_a", {
      headers: STAFF_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(f.id);
  });

  it("PATCH /fulfillments/{id}/tracking forwards the staff actor", async () => {
    let captured: { id: string; trackingCode: string | null } | null = null;
    const app = buildApp(
      makeShippingService({
        async setTracking(id, opts) {
          captured = { id, trackingCode: opts.trackingCode };
          return makeFulfillment({ id, trackingCode: opts.trackingCode });
        },
      }),
      makeOrderService(),
    );
    const res = await app.request("/admin/v1/fulfillments/ful_a/tracking", {
      method: "PATCH",
      headers: { ...STAFF_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ trackingCode: "JNE-12345" }),
    });
    expect(res.status).toBe(200);
    expect(captured).toEqual({ id: "ful_a", trackingCode: "JNE-12345" });
  });

  it("POST /fulfillments/{id}/mark-shipped forwards optional tracking code", async () => {
    let received: { trackingCode: string | null | undefined } | null = null;
    const app = buildApp(
      makeShippingService({
        async markShipped(_id, opts) {
          received = { trackingCode: opts.trackingCode };
          return makeFulfillment({
            id: "ful_a",
            status: "shipped",
            trackingCode: opts.trackingCode ?? null,
          });
        },
      }),
      makeOrderService(),
    );
    const res = await app.request("/admin/v1/fulfillments/ful_a/mark-shipped", {
      method: "POST",
      headers: { ...STAFF_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ trackingCode: "JNE-12345" }),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual({ trackingCode: "JNE-12345" });
  });

  it("POST /fulfillments/{id}/mark-delivered also nudges the parent order to fulfilled", async () => {
    const orderTransitions: Array<{ id: string; toStatus: string }> = [];
    const app = buildApp(
      makeShippingService({
        async markDelivered(id) {
          return makeFulfillment({
            id,
            orderId: "ord_a",
            status: "delivered",
            deliveredAt: NOW,
          });
        },
      }),
      makeOrderService({
        async transitionStatus(id, toStatus) {
          orderTransitions.push({ id, toStatus });
          return {} as unknown as Order;
        },
      }),
    );
    const res = await app.request(
      "/admin/v1/fulfillments/ful_a/mark-delivered",
      {
        method: "POST",
        headers: { ...STAFF_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    expect(orderTransitions).toEqual([{ id: "ord_a", toStatus: "fulfilled" }]);
  });

  it("mark-delivered swallows the order-side conflict (already fulfilled / cancelled)", async () => {
    const app = buildApp(
      makeShippingService({
        async markDelivered() {
          return makeFulfillment({
            id: "ful_a",
            orderId: "ord_a",
            status: "delivered",
          });
        },
      }),
      makeOrderService({
        async transitionStatus() {
          throw new ConflictError("Invalid order status transition.", {
            code: "invalid_transition",
            from: "fulfilled",
            to: "fulfilled",
          });
        },
      }),
    );
    const res = await app.request(
      "/admin/v1/fulfillments/ful_a/mark-delivered",
      {
        method: "POST",
        headers: { ...STAFF_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("delivered");
  });

  it("POST /fulfillments/{id}/cancel forwards the reason but does NOT cancel the order", async () => {
    let receivedReason: string | null | undefined = undefined;
    const orderCancels: string[] = [];
    const app = buildApp(
      makeShippingService({
        async cancel(_id, opts) {
          receivedReason = opts.reason;
          return makeFulfillment({ id: "ful_a", status: "cancelled" });
        },
      }),
      makeOrderService({
        async cancelOrder(id) {
          orderCancels.push(id);
          return {} as unknown as Order;
        },
      }),
    );
    const res = await app.request("/admin/v1/fulfillments/ful_a/cancel", {
      method: "POST",
      headers: { ...STAFF_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ reason: "courier issue" }),
    });
    expect(res.status).toBe(200);
    expect(receivedReason).toBe("courier issue");
    expect(orderCancels).toEqual([]);
  });
});

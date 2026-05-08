/**
 * Payments routes — smoke tests over Hono's `app.request()`.
 *
 * Mirrors the orders/checkout route test pattern: routers are built
 * with a fake `PaymentService` (and a fake `OrderService` for the
 * storefront's checkout-keyed lookup) injected via the public route
 * builders. Auth is faked via `authService.verifyApiKey` /
 * `authService.getStaffProfile`. The HTTP-layer idempotency middleware
 * is wired with an in-memory store so we never touch the database.
 *
 * Coverage:
 *   1. Admin list + detail respond with the standard envelopes.
 *   2. Admin capture rejects without an Idempotency-Key (400).
 *   3. Admin capture replays a same-key + same-body call.
 *   4. Storefront initiate routes through to the service and returns
 *      the canonical outcome shape.
 *   5. Webhook ingress accepts a signed body; rejects an unsigned one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import {
  IDEMPOTENCY_STATUS_IN_FLIGHT,
  type ClaimResult,
  type IdempotencyStore,
} from "../../../src/middleware/idempotency.js";
import { authService } from "../../../src/modules/auth/index.js";
import {
  buildPaymentsAdminRoutes,
  buildPaymentsStorefrontRoutes,
  buildPaymentsWebhookRoutes,
} from "../../../src/modules/payments/index.js";
import {
  createInMemoryTestPaymentProvider,
  signTestWebhook,
} from "../../../src/modules/payments/providers/in-memory.js";
import { createPaymentProviderRegistry } from "../../../src/modules/payments/providers/registry.js";
import { PaymentServiceImpl } from "../../../src/modules/payments/service.js";
import type { PaymentService } from "../../../src/modules/payments/index.js";
import type { OrderService } from "../../../src/modules/orders/index.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  PaymentsRepository,
} from "../../../src/modules/payments/repository.js";
import type {
  NewPaymentAttemptRow,
  NewPaymentRow,
  PaymentAttemptRow,
  PaymentRow,
} from "../../../src/db/schema/index.js";

installBigIntJsonSerializer();

const NOW = new Date("2026-05-08T00:00:00.000Z");
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
// In-memory fakes
// ---------------------------------------------------------------------------

interface MemoryRecord {
  requestHash: string;
  status: number;
  body: unknown;
}

function createMemoryIdempotencyStore(): IdempotencyStore {
  const map = new Map<string, MemoryRecord>();
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
      const existing = map.get(key)!;
      return { kind: "existing", record: { ...existing } };
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

function createInMemoryPaymentsRepo(): PaymentsRepository {
  const payments = new Map<string, PaymentRow>();
  const attempts: PaymentAttemptRow[] = [];
  let clock = 0;
  const tick = () => new Date(NOW.getTime() + ++clock);

  const repo: PaymentsRepository = {
    async insertPayment(row: NewPaymentRow): Promise<PaymentRow> {
      const now = tick();
      const inserted: PaymentRow = {
        id: row.id,
        orderId: row.orderId,
        provider: row.provider,
        providerRef: row.providerRef ?? null,
        currency: row.currency,
        amount: row.amount,
        status: row.status ?? "pending",
        idempotencyKey: row.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      };
      payments.set(inserted.id, inserted);
      return inserted;
    },
    async getPaymentById(id) {
      return payments.get(id) ?? null;
    },
    async getPaymentByIdForUpdate(id) {
      return payments.get(id) ?? null;
    },
    async getPaymentByIdempotencyKey(key) {
      for (const p of payments.values()) {
        if (p.idempotencyKey === key) return p;
      }
      return null;
    },
    async getPaymentByOrderId(orderId) {
      const matches = [...payments.values()].filter(
        (p) => p.orderId === orderId,
      );
      matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ?? null;
    },
    async getPaymentByProviderRef(provider, providerRef) {
      for (const p of payments.values()) {
        if (p.provider === provider && p.providerRef === providerRef) return p;
      }
      return null;
    },
    async listPayments(filters) {
      const rows = [...payments.values()];
      return { rows: rows.slice(0, filters.pageSize), total: rows.length };
    },
    async updatePayment(id, patch) {
      const existing = payments.get(id);
      if (!existing) return null;
      const updated: PaymentRow = {
        ...existing,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.providerRef !== undefined ? { providerRef: patch.providerRef } : {}),
        updatedAt: tick(),
      };
      payments.set(id, updated);
      return updated;
    },
    async insertAttempt(row: NewPaymentAttemptRow): Promise<PaymentAttemptRow> {
      const inserted: PaymentAttemptRow = {
        id: row.id,
        paymentId: row.paymentId,
        kind: row.kind,
        status: row.status,
        requestPayload: (row.requestPayload as object) ?? {},
        responsePayload: (row.responsePayload as object) ?? null,
        errorMessage: row.errorMessage ?? null,
        createdAt: tick(),
      };
      attempts.push(inserted);
      return inserted;
    },
    async listAttemptsForPayment(paymentId) {
      return attempts
        .filter((a) => a.paymentId === paymentId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async withTransaction(fn) {
      return fn(repo);
    },
  };
  return repo;
}

function createFakeOrderService(
  overrides: Partial<{ status: string; missing: boolean }> = {},
): OrderService {
  const fail = (): never => {
    throw new Error("not implemented in this test");
  };
  const baseOrder = {
    id: "ord_1",
    orderNumber: "ORD-2026-000100",
    customerId: "cust_1" as string | null,
    email: "buyer@example.com",
    currency: "IDR",
    status: (overrides.status as
      | "pending_payment"
      | "paid"
      | "fulfilled"
      | "cancelled"
      | "refunded") ?? "pending_payment",
    subtotal: { amount: 500_000n, currency: "IDR" },
    tax: { amount: 55_000n, currency: "IDR" },
    taxRateCode: null,
    taxRateBasisPoints: null,
    shipping: { amount: 10_000n, currency: "IDR" },
    shippingMethodCode: "flat",
    total: { amount: 565_000n, currency: "IDR" },
    shippingAddressSnapshot: {
      id: "adr_ship",
      customerId: "cust_1",
      kind: "shipping" as const,
      recipientName: "Budi",
      phone: "+62",
      addressLine1: "Jl. Mawar 1",
      addressLine2: null,
      provinsiId: "31",
      kotaKabupatenId: "3171",
      kecamatanId: "317101",
      kelurahanId: null,
      postalCode: "10110",
      notes: null,
    },
    billingAddressSnapshot: null,
    paymentMethod: "manual_bank_transfer",
    items: [],
    paidAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    refundedAt: null,
    cancellationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    async createFromIntent() {
      return fail();
    },
    async getOrderById(id) {
      if (overrides.missing) return null;
      return id === "ord_1" ? baseOrder : null;
    },
    async getOrderByNumber() {
      return null;
    },
    async getOrderByCheckoutId() {
      if (overrides.missing) return null;
      return baseOrder;
    },
    async listOrders() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async listCustomerOrders() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async transitionStatus() {
      return baseOrder;
    },
    async cancelOrder() {
      return fail();
    },
    async listStatusHistory() {
      return [];
    },
  };
}

function buildPaymentService(orderService: OrderService): {
  service: PaymentService;
  provider: ReturnType<typeof createInMemoryTestPaymentProvider>;
} {
  const provider = createInMemoryTestPaymentProvider();
  const registry = createPaymentProviderRegistry();
  registry.register(provider);
  const service = new PaymentServiceImpl(
    createInMemoryPaymentsRepo(),
    orderService,
    registry,
  );
  return { service, provider };
}

function buildAdminApp(service: PaymentService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route(
    "/admin/v1",
    buildPaymentsAdminRoutes(service, {
      idempotencyStore: createMemoryIdempotencyStore(),
    }),
  );
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(
  service: PaymentService,
  orderService: OrderService,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route(
    "/storefront/v1",
    buildPaymentsStorefrontRoutes(service, {
      orderService,
      idempotencyStore: createMemoryIdempotencyStore(),
    }),
  );
  app.onError(errorHandler);
  return app;
}

function buildWebhookApp(service: PaymentService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/", buildPaymentsWebhookRoutes(service));
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

describe("admin payments — list & detail", () => {
  it("rejects an anonymous list request with 401", async () => {
    const { service } = buildPaymentService(createFakeOrderService());
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/payments");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a missing payment", async () => {
    const { service } = buildPaymentService(createFakeOrderService());
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/payments/pay_missing", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(404);
  });
});

describe("admin payments — capture", () => {
  it("rejects a capture call without Idempotency-Key (400)", async () => {
    const { service } = buildPaymentService(createFakeOrderService());
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/payments/pay_1/capture", {
      method: "POST",
      headers: {
        authorization: "Bearer staff-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { code?: string } } };
    expect(body.error.details?.code).toBe("idempotency_key_required");
  });

  it("on a same-key replay returns the cached response without re-calling the service", async () => {
    const orders = createFakeOrderService();
    const { service } = buildPaymentService(orders);
    // Initiate first so a payment row exists for the capture.
    const initiated = await service.initiate({
      orderId: "ord_1",
      providerCode: "in_memory_test",
      idempotencyKey: "init-key",
      customer: { id: null, email: "buyer@example.com", phone: null, name: null },
      metadata: { code: "TEST_PENDING_route" },
    });

    const captureSpy = vi.spyOn(service, "capture");
    const app = buildAdminApp(service);
    const opts = {
      method: "POST",
      headers: {
        authorization: "Bearer staff-key",
        "content-type": "application/json",
        "idempotency-key": "cap-key",
      },
      body: JSON.stringify({}),
    } as const;
    const first = await app.request(
      `/admin/v1/payments/${initiated.paymentId}/capture`,
      opts,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/admin/v1/payments/${initiated.paymentId}/capture`,
      opts,
    );
    expect(second.status).toBe(200);
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

describe("storefront payments — initiate", () => {
  it("requires an Idempotency-Key header", async () => {
    const orders = createFakeOrderService();
    const { service } = buildPaymentService(orders);
    const app = buildStorefrontApp(service, orders);
    const res = await app.request(
      "/storefront/v1/checkouts/chk_1/payment/initiate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerCode: "in_memory_test" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("404s when no order exists for the checkout id", async () => {
    const orders = createFakeOrderService({ missing: true });
    const { service } = buildPaymentService(orders);
    const app = buildStorefrontApp(service, orders);
    const res = await app.request(
      "/storefront/v1/checkouts/chk_unknown/payment/initiate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "init-1",
        },
        body: JSON.stringify({ providerCode: "in_memory_test" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns the canonical outcome shape on the happy path", async () => {
    const orders = createFakeOrderService();
    const { service } = buildPaymentService(orders);
    const app = buildStorefrontApp(service, orders);
    const res = await app.request(
      "/storefront/v1/checkouts/chk_1/payment/initiate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "init-happy",
        },
        body: JSON.stringify({ providerCode: "in_memory_test" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      paymentId: string;
      redirectUrl?: string;
    };
    expect(body.status).toBe("captured");
    expect(body.paymentId).toMatch(/^pay_/);
    expect(body.redirectUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

describe("payments webhook", () => {
  it("accepts a signed webhook body", async () => {
    const orders = createFakeOrderService();
    const { service, provider } = buildPaymentService(orders);
    // Initiate first (pending) so the webhook has a row to dispatch
    // against.
    const initiated = await service.initiate({
      orderId: "ord_1",
      providerCode: "in_memory_test",
      idempotencyKey: "init-wh",
      customer: { id: null, email: "buyer@example.com", phone: null, name: null },
      metadata: { code: "TEST_PENDING_wh" },
    });
    const detail = await service.getById(initiated.paymentId);
    const providerRef = detail!.providerRef!;

    const app = buildWebhookApp(service);
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef,
      status: "captured",
    });
    const res = await app.request("/webhooks/payments/in_memory_test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mt-test-signature": signTestWebhook(provider.secret, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; paymentId: string };
    expect(json.status).toBe("accepted");
    expect(json.paymentId).toBe(initiated.paymentId);
  });

  it("rejects an unsigned body with 400 webhook_signature_invalid", async () => {
    const orders = createFakeOrderService();
    const { service } = buildPaymentService(orders);
    const app = buildWebhookApp(service);
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: "test_x",
      status: "captured",
    });
    const res = await app.request("/webhooks/payments/in_memory_test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: { details?: { code?: string } };
    };
    expect(json.error.details?.code).toBe("webhook_signature_invalid");
  });
});

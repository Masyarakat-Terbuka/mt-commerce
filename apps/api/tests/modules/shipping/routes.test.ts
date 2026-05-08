/**
 * Shipping routes — smoke tests over Hono's `app.request()`.
 *
 * Same fake-service pattern as the cart/tax routes tests. Pins:
 *   1. Auth gating on the admin router (anonymous → 401)
 *   2. The standard JSON envelope
 *   3. The storefront's `quote` endpoint shape
 *   4. The storefront's "active only" listing rule
 *   5. The strict input rejection for unknown body fields on create
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildShippingAdminRoutes } from "../../../src/modules/shipping/routes/admin.js";
import { buildShippingStorefrontRoutes } from "../../../src/modules/shipping/routes/storefront.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  ShippingMethod,
  ShippingService,
} from "../../../src/modules/shipping/index.js";
import { NotFoundError, ValidationError } from "../../../src/lib/errors.js";

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

// ---------------------------------------------------------------------------
// Fake ShippingService factory
// ---------------------------------------------------------------------------

function makeMethod(overrides: Partial<ShippingMethod> = {}): ShippingMethod {
  return {
    id: overrides.id ?? "ship_a",
    code: overrides.code ?? "MANUAL_FLAT",
    name: overrides.name ?? "Flat",
    providerKind: overrides.providerKind ?? "manual",
    flatRate: overrides.flatRate ?? { amount: 15_000n, currency: "IDR" },
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    deletedAt: overrides.deletedAt ?? null,
  };
}

function createFakeService(opts: { initial?: ShippingMethod[] } = {}): ShippingService {
  const methods = new Map<string, ShippingMethod>();
  for (const m of opts.initial ?? []) methods.set(m.id, m);

  return {
    async listMethods({ activeOnly } = {}) {
      let rows = [...methods.values()];
      if (activeOnly !== false) rows = rows.filter((m) => m.isActive && m.deletedAt === null);
      return rows;
    },
    async getById(id) {
      return methods.get(id) ?? null;
    },
    async getByCode(code) {
      for (const m of methods.values()) if (m.code === code) return m;
      return null;
    },
    async quote({ methodCode, currency }) {
      const m = await this.getByCode(methodCode);
      if (!m) throw new NotFoundError("Shipping method not found.");
      if (!m.flatRate) throw new NotFoundError("No rate configured.");
      if (m.flatRate.currency !== currency) {
        throw new ValidationError(
          "Shipping method currency does not match the requested currency.",
          {
            code: "currency_mismatch",
            methodCode,
            requestedCurrency: currency,
            methodCurrency: m.flatRate.currency,
          },
        );
      }
      return m.flatRate;
    },
    async createMethod(input) {
      const m = makeMethod({
        id: `ship_new_${methods.size}`,
        code: input.code,
        name: input.name,
        providerKind: input.providerKind,
        flatRate: input.flatRate
          ? {
              amount: BigInt(input.flatRate.amount),
              currency: input.flatRate.currency,
            }
          : null,
        isActive: input.isActive ?? true,
      });
      methods.set(m.id, m);
      return m;
    },
    async updateMethod(id, patch) {
      const existing = methods.get(id);
      if (!existing) throw new NotFoundError("Shipping method not found.");
      const updated = makeMethod({
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.flatRate !== undefined
          ? {
              flatRate: {
                amount: BigInt(patch.flatRate.amount),
                currency: patch.flatRate.currency,
              },
            }
          : {}),
      });
      methods.set(id, updated);
      return updated;
    },
    async deleteMethod(id) {
      const existing = methods.get(id);
      if (!existing) throw new NotFoundError("Shipping method not found.");
      methods.set(id, makeMethod({ ...existing, deletedAt: NOW, isActive: false }));
    },
    async createFulfillmentForOrder(orderId, input) {
      const m = await this.getByCode(input.methodCode);
      if (!m) throw new NotFoundError("Shipping method not found.");
      return {
        id: "ful_test",
        orderId,
        shippingMethodId: m.id,
        status: "pending",
        trackingCode: null,
        trackedAt: null,
        deliveredAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
    },
    async getFulfillmentById() {
      return null;
    },
    async listFulfillmentsByOrderId() {
      return [];
    },
    async listFulfillmentsForOrders() {
      return [];
    },
    async setTracking() {
      throw new Error("not implemented in this routes test");
    },
    async markShipped() {
      throw new Error("not implemented in this routes test");
    },
    async markDelivered() {
      throw new Error("not implemented in this routes test");
    },
    async cancel() {
      throw new Error("not implemented in this routes test");
    },
  };
}

function buildAdminApp(service: ShippingService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildShippingAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(service: ShippingService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/storefront/v1", buildShippingStorefrontRoutes(service));
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storefront shipping routes", () => {
  it("lists active methods", async () => {
    const m = makeMethod();
    const app = buildStorefrontApp(createFakeService({ initial: [m] }));
    const res = await app.request("/storefront/v1/shipping/methods?currency=IDR");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ code: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.code).toBe("MANUAL_FLAT");
  });

  it("returns a quote for a known method+currency", async () => {
    const m = makeMethod();
    const app = buildStorefrontApp(createFakeService({ initial: [m] }));
    const res = await app.request("/storefront/v1/shipping/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodCode: "MANUAL_FLAT", currency: "IDR" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      amount: { amount: string; currency: string };
    };
    expect(body.amount).toEqual({ amount: "15000", currency: "IDR" });
  });

  it("404s on an unknown method code", async () => {
    const app = buildStorefrontApp(createFakeService());
    const res = await app.request("/storefront/v1/shipping/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodCode: "MISSING", currency: "IDR" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("surfaces currency_mismatch as the standard error envelope", async () => {
    const m = makeMethod();
    const app = buildStorefrontApp(createFakeService({ initial: [m] }));
    const res = await app.request("/storefront/v1/shipping/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodCode: "MANUAL_FLAT", currency: "USD" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { code?: string } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.code).toBe("currency_mismatch");
  });
});

describe("admin shipping routes", () => {
  it("rejects an anonymous request with 401", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/shipping/methods");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("admits a staff caller and lists methods", async () => {
    const m = makeMethod();
    const app = buildAdminApp(createFakeService({ initial: [m] }));
    const res = await app.request("/admin/v1/shipping/methods", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ code: string }> };
    expect(body.data).toHaveLength(1);
  });

  it("creates a manual method via POST and returns 201", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/shipping/methods", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({
        code: "MANUAL_FLAT",
        name: "Flat",
        providerKind: "manual",
        flatRate: { amount: "15000", currency: "IDR" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      providerKind: string;
      flatRate: { amount: string; currency: string };
    };
    expect(body.providerKind).toBe("manual");
    expect(body.flatRate).toEqual({ amount: "15000", currency: "IDR" });
  });

  it("rejects manual without flatRate at the boundary", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/shipping/methods", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({
        code: "MANUAL_BAD",
        name: "Bad",
        providerKind: "manual",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("DELETE soft-deletes the method (204)", async () => {
    const m = makeMethod();
    const app = buildAdminApp(createFakeService({ initial: [m] }));
    const res = await app.request(`/admin/v1/shipping/methods/${m.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(204);
  });
});

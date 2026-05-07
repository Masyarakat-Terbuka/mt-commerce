/**
 * Tax routes — smoke tests over Hono's `app.request()`.
 *
 * Mirrors the cart/catalog routes test pattern: the routers are built
 * with a fake `TaxService` injected via the public route builders so
 * the tests focus on:
 *   1. Auth gating on the admin router (anonymous → 401, staff → 200/201)
 *   2. The standard JSON envelope
 *   3. The storefront's public `/tax/rate?currency=` lookup, including
 *      the 404-when-no-default contract
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildTaxAdminRoutes } from "../../../src/modules/tax/routes/admin.js";
import { buildTaxStorefrontRoutes } from "../../../src/modules/tax/routes/storefront.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type { TaxRate, TaxService } from "../../../src/modules/tax/index.js";
import { NotFoundError } from "../../../src/lib/errors.js";

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
// Fake TaxService factory
// ---------------------------------------------------------------------------

function makeRate(overrides: Partial<TaxRate> = {}): TaxRate {
  return {
    id: overrides.id ?? "tax_a",
    code: overrides.code ?? "PPN_11",
    name: overrides.name ?? "PPN 11%",
    rateBasisPoints: overrides.rateBasisPoints ?? 1100,
    currency: overrides.currency ?? "IDR",
    isDefault: overrides.isDefault ?? true,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    archivedAt: overrides.archivedAt ?? null,
  };
}

function createFakeService(opts: {
  initial?: TaxRate[];
  defaultByCurrency?: Record<string, TaxRate | null>;
} = {}): TaxService {
  const rates = new Map<string, TaxRate>();
  for (const r of opts.initial ?? []) rates.set(r.id, r);

  return {
    async listRates() {
      return [...rates.values()];
    },
    async getRateById(id) {
      return rates.get(id) ?? null;
    },
    async getRateByCode(code) {
      for (const r of rates.values()) if (r.code === code) return r;
      return null;
    },
    async getDefaultRate(currency) {
      if (opts.defaultByCurrency && currency in opts.defaultByCurrency) {
        return opts.defaultByCurrency[currency] ?? null;
      }
      for (const r of rates.values()) {
        if (r.currency === currency && r.isDefault && r.archivedAt === null) {
          return r;
        }
      }
      return null;
    },
    async createRate(input) {
      const r = makeRate({
        id: `tax_new_${rates.size}`,
        code: input.code,
        name: input.name,
        rateBasisPoints: input.rateBasisPoints,
        currency: input.currency,
        isDefault: input.isDefault,
      });
      rates.set(r.id, r);
      return r;
    },
    async updateRate(id, patch) {
      const existing = rates.get(id);
      if (!existing) throw new NotFoundError("Tax rate not found.");
      const updated = makeRate({
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rateBasisPoints !== undefined
          ? { rateBasisPoints: patch.rateBasisPoints }
          : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
      });
      rates.set(id, updated);
      return updated;
    },
    async archiveRate(id) {
      const existing = rates.get(id);
      if (!existing) throw new NotFoundError("Tax rate not found.");
      const archived = makeRate({ ...existing, archivedAt: NOW, isDefault: false });
      rates.set(id, archived);
      return archived;
    },
    applyTax(money, rate) {
      const factor = rate.rateBasisPoints / 10_000;
      return {
        amount: BigInt(Math.round(Number(money.amount) * factor)),
        currency: money.currency,
      };
    },
  };
}

function buildAdminApp(service: TaxService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildTaxAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(service: TaxService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/storefront/v1", buildTaxStorefrontRoutes(service));
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storefront tax routes", () => {
  it("returns the default rate for a currency", async () => {
    const rate = makeRate({ id: "tax_a", code: "PPN_11", isDefault: true });
    const app = buildStorefrontApp(createFakeService({ initial: [rate] }));
    const res = await app.request("/storefront/v1/tax/rate?currency=IDR");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; rateBasisPoints: number };
    expect(body.code).toBe("PPN_11");
    expect(body.rateBasisPoints).toBe(1100);
  });

  it("404s when no default is configured for the currency", async () => {
    const app = buildStorefrontApp(
      createFakeService({ defaultByCurrency: { USD: null } }),
    );
    const res = await app.request("/storefront/v1/tax/rate?currency=USD");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("400s on a malformed currency", async () => {
    const app = buildStorefrontApp(createFakeService());
    const res = await app.request("/storefront/v1/tax/rate?currency=zzz");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});

describe("admin tax routes — auth gating", () => {
  it("rejects anonymous list with 401", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/tax/rates");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("admits a staff caller and lists rates", async () => {
    const rate = makeRate();
    const app = buildAdminApp(createFakeService({ initial: [rate] }));
    const res = await app.request("/admin/v1/tax/rates", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ code: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.code).toBe("PPN_11");
  });

  it("creates a rate via POST and returns 201", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/tax/rates", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({
        code: "PPN_11",
        name: "PPN 11%",
        rateBasisPoints: 1100,
        currency: "IDR",
        isDefault: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; isDefault: boolean };
    expect(body.code).toBe("PPN_11");
    expect(body.isDefault).toBe(true);
  });

  it("rejects an invalid basis points value with 400", async () => {
    const app = buildAdminApp(createFakeService());
    const res = await app.request("/admin/v1/tax/rates", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer staff-key",
      },
      body: JSON.stringify({
        code: "PPN_OVER",
        name: "Over 100%",
        rateBasisPoints: 20000,
        currency: "IDR",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("set-default flips via the dedicated endpoint", async () => {
    const rate = makeRate({ id: "tax_a", isDefault: false });
    const app = buildAdminApp(createFakeService({ initial: [rate] }));
    const res = await app.request("/admin/v1/tax/rates/tax_a/set-default", {
      method: "POST",
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isDefault: boolean };
    expect(body.isDefault).toBe(true);
  });

  it("DELETE archives the rate (204)", async () => {
    const rate = makeRate({ id: "tax_a" });
    const app = buildAdminApp(createFakeService({ initial: [rate] }));
    const res = await app.request("/admin/v1/tax/rates/tax_a", {
      method: "DELETE",
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(204);
  });
});

/**
 * Shipping service — unit tests against an in-memory fake repository.
 *
 * Pins:
 *   - the manual provider's quote returns the configured flat rate
 *   - currency-mismatch surfaces as ValidationError with the expected code
 *   - inactive / soft-deleted methods reject through the service boundary
 *   - createMethod enforces the `manual ⇒ flatRate, plugin ⇒ no flatRate`
 *     invariant (defense-in-depth on top of the Zod schema and DB CHECK)
 */
import { describe, expect, it } from "vitest";
import { ShippingServiceImpl } from "../../../src/modules/shipping/service.js";
import type { ShippingRepository } from "../../../src/modules/shipping/repository.js";
import type { ShippingProvider } from "../../../src/modules/shipping/index.js";
import { manualShippingProvider } from "../../../src/modules/shipping/providers/manual.js";
import type {
  FulfillmentRow,
  NewFulfillmentRow,
  NewShippingMethodRow,
  ShippingMethodRow,
} from "../../../src/db/schema/index.js";
import type { ShippingProviderKind } from "../../../src/modules/shipping/types.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../src/lib/errors.js";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

interface FakeStore {
  methods: Map<string, ShippingMethodRow>;
  fulfillments: Map<string, FulfillmentRow>;
  clock: number;
}

function createStore(): FakeStore {
  return { methods: new Map(), fulfillments: new Map(), clock: 0 };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

function createFakeRepo(store: FakeStore): ShippingRepository {
  const repo: ShippingRepository = {
    async insertMethod(row: NewShippingMethodRow): Promise<ShippingMethodRow> {
      const now = tick(store);
      const r: ShippingMethodRow = {
        id: row.id,
        code: row.code,
        name: row.name,
        providerKind: row.providerKind,
        flatRateAmount: row.flatRateAmount ?? null,
        flatRateCurrency: row.flatRateCurrency ?? null,
        isActive: row.isActive ?? true,
        createdAt: now,
        updatedAt: now,
        deletedAt: row.deletedAt ?? null,
      };
      store.methods.set(r.id, r);
      return r;
    },
    async getMethodById(id) {
      return store.methods.get(id) ?? null;
    },
    async getMethodByCode(code) {
      for (const r of store.methods.values()) if (r.code === code) return r;
      return null;
    },
    async listMethods({ activeOnly }) {
      let rows = [...store.methods.values()];
      if (activeOnly)
        rows = rows.filter((r) => r.isActive && r.deletedAt === null);
      rows.sort((a, b) => a.code.localeCompare(b.code));
      return rows;
    },
    async updateMethod(id, patch) {
      const existing = store.methods.get(id);
      if (!existing) return null;
      const updated: ShippingMethodRow = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.flatRateAmount !== undefined
          ? { flatRateAmount: patch.flatRateAmount }
          : {}),
        ...(patch.flatRateCurrency !== undefined
          ? { flatRateCurrency: patch.flatRateCurrency }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.deletedAt !== undefined
          ? { deletedAt: patch.deletedAt as Date | null }
          : {}),
        updatedAt: tick(store),
      };
      store.methods.set(id, updated);
      return updated;
    },
    async softDeleteMethod(id) {
      const existing = store.methods.get(id);
      if (!existing) return null;
      const deleted: ShippingMethodRow = {
        ...existing,
        deletedAt: tick(store),
        isActive: false,
        updatedAt: tick(store),
      };
      store.methods.set(id, deleted);
      return deleted;
    },
    async insertFulfillment(row: NewFulfillmentRow): Promise<FulfillmentRow> {
      const now = tick(store);
      const r: FulfillmentRow = {
        id: row.id,
        orderIntentId: row.orderIntentId,
        shippingMethodId: row.shippingMethodId,
        status: row.status ?? "pending",
        trackingCode: row.trackingCode ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.fulfillments.set(r.id, r);
      return r;
    },
    async getFulfillmentById(id) {
      return store.fulfillments.get(id) ?? null;
    },
    async withTransaction(fn) {
      return fn(repo);
    },
  };
  return repo;
}

function buildService(): {
  service: ShippingServiceImpl;
  store: FakeStore;
} {
  const store = createStore();
  const providers = new Map<ShippingProviderKind, ShippingProvider>([
    ["manual", manualShippingProvider],
  ]);
  return {
    service: new ShippingServiceImpl(createFakeRepo(store), providers),
    store,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShippingService.createMethod", () => {
  it("creates a manual method with a flat rate", async () => {
    const { service } = buildService();
    const m = await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
      isActive: true,
    });
    expect(m.id).toMatch(/^ship_/);
    expect(m.code).toBe("MANUAL_FLAT");
    expect(m.providerKind).toBe("manual");
    expect(m.flatRate).toEqual({ amount: 15_000n, currency: "IDR" });
  });

  it("rejects manual without flatRate at the service boundary (defense-in-depth)", async () => {
    const { service } = buildService();
    // The Zod schema would also catch this; we construct the input
    // shape manually here to confirm the service does NOT trust the
    // route layer alone.
    await expect(
      service.createMethod({
        code: "MANUAL_BAD",
        name: "Bad",
        providerKind: "manual",
      } as never),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects plugin WITH a flatRate at the service boundary", async () => {
    const { service } = buildService();
    await expect(
      service.createMethod({
        code: "PLUGIN_BAD",
        name: "Bad",
        providerKind: "plugin",
        flatRate: { amount: "1", currency: "IDR" },
      } as never),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a duplicate code with ConflictError", async () => {
    const { service } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    await expect(
      service.createMethod({
        code: "MANUAL_FLAT",
        name: "Dup",
        providerKind: "manual",
        flatRate: { amount: "15000", currency: "IDR" },
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("ShippingService.quote", () => {
  it("returns the configured flat rate for a manual method", async () => {
    const { service } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    const amount = await service.quote({
      methodCode: "MANUAL_FLAT",
      currency: "IDR",
    });
    expect(amount).toEqual({ amount: 15_000n, currency: "IDR" });
  });

  it("404s on an unknown method code", async () => {
    const { service } = buildService();
    await expect(
      service.quote({ methodCode: "DOES_NOT_EXIST", currency: "IDR" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("404s on a soft-deleted method", async () => {
    const { service } = buildService();
    const m = await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    await service.deleteMethod(m.id);
    await expect(
      service.quote({ methodCode: "MANUAL_FLAT", currency: "IDR" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("409s on an inactive (but not deleted) method", async () => {
    const { service } = buildService();
    const m = await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    await service.updateMethod(m.id, { isActive: false });
    await expect(
      service.quote({ methodCode: "MANUAL_FLAT", currency: "IDR" }),
    ).rejects.toThrow(ConflictError);
  });

  it("rejects currency mismatch with ValidationError {code:'currency_mismatch'}", async () => {
    const { service } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    let captured: unknown;
    try {
      await service.quote({ methodCode: "MANUAL_FLAT", currency: "USD" });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ValidationError);
    const details = (captured as ValidationError).details as {
      code?: string;
    };
    expect(details.code).toBe("currency_mismatch");
  });
});

describe("ShippingService.deleteMethod", () => {
  it("soft-deletes idempotently", async () => {
    const { service } = buildService();
    const m = await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    await service.deleteMethod(m.id);
    // Second delete is a no-op (no error thrown).
    await service.deleteMethod(m.id);
    const after = await service.getById(m.id);
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.isActive).toBe(false);
  });

  it("404s on a missing id", async () => {
    const { service } = buildService();
    await expect(service.deleteMethod("ship_missing")).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("ShippingService.createFulfillment", () => {
  it("creates a pending fulfillment for an order_intent", async () => {
    const { service } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    const f = await service.createFulfillment("oint_test", "MANUAL_FLAT");
    expect(f.id).toMatch(/^ful_/);
    expect(f.status).toBe("pending");
    expect(f.orderIntentId).toBe("oint_test");
  });

  it("404s on a missing method code", async () => {
    const { service } = buildService();
    await expect(
      service.createFulfillment("oint_test", "MISSING"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("ShippingService.listMethods", () => {
  it("active-only filters out deleted and inactive methods", async () => {
    const { service } = buildService();
    const a = await service.createMethod({
      code: "ACTIVE",
      name: "Active",
      providerKind: "manual",
      flatRate: { amount: "10000", currency: "IDR" },
    });
    const b = await service.createMethod({
      code: "INACTIVE",
      name: "Inactive",
      providerKind: "manual",
      flatRate: { amount: "10000", currency: "IDR" },
      isActive: false,
    });
    const c = await service.createMethod({
      code: "DELETED",
      name: "Deleted",
      providerKind: "manual",
      flatRate: { amount: "10000", currency: "IDR" },
    });
    await service.deleteMethod(c.id);

    const active = await service.listMethods({ activeOnly: true });
    expect(active.map((m) => m.id)).toEqual([a.id]);

    const all = await service.listMethods({ activeOnly: false });
    expect(all.map((m) => m.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

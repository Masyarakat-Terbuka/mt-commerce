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
  AuditLogRow,
  FulfillmentRow,
  NewAuditLogRow,
  NewFulfillmentRow,
  NewShippingMethodRow,
  ShippingMethodRow,
} from "../../../src/db/schema/index.js";
import type { AuditRepository } from "../../../src/modules/audit/repository.js";
import type { AuditService } from "../../../src/modules/audit/service.js";
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
  /** Captured audit rows so assertions can verify the audit trail. */
  auditEvents: AuditLogRow[];
  clock: number;
}

function createStore(): FakeStore {
  return {
    methods: new Map(),
    fulfillments: new Map(),
    auditEvents: [],
    clock: 0,
  };
}

/**
 * Tiny in-memory audit repo. Captures rows into the shared store so tests
 * can assert on the audit trail without standing up the audit module.
 */
function createFakeAuditRepo(store: FakeStore): AuditRepository {
  return {
    async insertEvent(row: NewAuditLogRow): Promise<AuditLogRow> {
      const inserted: AuditLogRow = {
        id: row.id,
        entityKind: row.entityKind,
        entityId: row.entityId,
        action: row.action,
        actorKind: row.actorKind,
        actorId: row.actorId ?? null,
        details: (row.details ?? {}) as Record<string, unknown>,
        reason: row.reason ?? null,
        createdAt: new Date(),
      };
      store.auditEvents.push(inserted);
      return inserted;
    },
    async listForEntity() {
      return { rows: [], total: 0 };
    },
  };
}

/**
 * Audit-service fake that delegates to whichever audit repo the caller
 * passed in (the in-tx repo from `withTransaction`). Mirrors the audit
 * module's contract: required to ride the caller's repo when one is
 * provided so the audit insert lands in the same transaction.
 */
function createFakeAuditService(store: FakeStore): AuditService {
  const fallback = createFakeAuditRepo(store);
  return {
    async recordEvent(input) {
      const repo = input.repo ?? fallback;
      const inserted = await repo.insertEvent({
        id: `aud_${store.auditEvents.length + 1}`,
        entityKind: input.entityKind,
        entityId: input.entityId,
        action: input.action,
        actorKind:
          input.actor.kind === "system"
            ? "system"
            : input.actor.kind === "staff"
              ? "staff"
              : "customer",
        actorId:
          input.actor.kind === "staff"
            ? input.actor.userId
            : input.actor.kind === "customer"
              ? input.actor.customerId ?? null
              : null,
        details: (input.details ?? {}) as Record<string, unknown>,
        reason: input.reason ?? null,
      });
      return {
        id: inserted.id,
        entityKind: inserted.entityKind,
        entityId: inserted.entityId,
        action: inserted.action,
        actorKind: inserted.actorKind as "system" | "staff" | "customer",
        actorId: inserted.actorId ?? null,
        details: (inserted.details ?? {}) as Record<string, unknown>,
        reason: inserted.reason ?? null,
        createdAt: inserted.createdAt,
      };
    },
    async listForEntity() {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
  };
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
        orderId: row.orderId,
        shippingMethodId: row.shippingMethodId,
        status: row.status ?? "pending",
        trackingCode: row.trackingCode ?? null,
        trackedAt: row.trackedAt ?? null,
        deliveredAt: row.deliveredAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.fulfillments.set(r.id, r);
      return r;
    },
    async getFulfillmentById(id) {
      return store.fulfillments.get(id) ?? null;
    },
    async getFulfillmentByIdForUpdate(id) {
      return store.fulfillments.get(id) ?? null;
    },
    async listFulfillmentsByOrderId(orderId) {
      return [...store.fulfillments.values()].filter(
        (f) => f.orderId === orderId,
      );
    },
    async listFulfillmentsForOrders(orderIds) {
      const set = new Set(orderIds);
      return [...store.fulfillments.values()].filter((f) =>
        set.has(f.orderId),
      );
    },
    async updateFulfillment(id, patch) {
      const existing = store.fulfillments.get(id);
      if (!existing) return null;
      const updated: FulfillmentRow = {
        ...existing,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.trackingCode !== undefined
          ? { trackingCode: patch.trackingCode }
          : {}),
        ...(patch.trackedAt !== undefined
          ? { trackedAt: patch.trackedAt }
          : {}),
        ...(patch.deliveredAt !== undefined
          ? { deliveredAt: patch.deliveredAt }
          : {}),
        updatedAt: tick(store),
      };
      store.fulfillments.set(id, updated);
      return updated;
    },
    async withTransaction(fn) {
      // Pair the shipping repo with a tx-scoped audit repo, mirroring
      // the production deps shape. Both are in-memory; the audit module
      // has its own dedicated test surface.
      return fn({ shipping: repo, audit: createFakeAuditRepo(store) });
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
    service: new ShippingServiceImpl(
      createFakeRepo(store),
      providers,
      createFakeAuditService(store),
    ),
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

describe("ShippingService.createFulfillmentForOrder", () => {
  it("creates a pending fulfillment for an order", async () => {
    const { service } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    const f = await service.createFulfillmentForOrder("ord_test", {
      methodCode: "MANUAL_FLAT",
    });
    expect(f.id).toMatch(/^ful_/);
    expect(f.status).toBe("pending");
    expect(f.orderId).toBe("ord_test");
    expect(f.trackedAt).toBeNull();
    expect(f.deliveredAt).toBeNull();
  });

  it("404s on a missing method code", async () => {
    const { service } = buildService();
    await expect(
      service.createFulfillmentForOrder("ord_test", { methodCode: "MISSING" }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Fulfillment lifecycle
// ---------------------------------------------------------------------------

describe("ShippingService fulfillment lifecycle", () => {
  async function setup() {
    const { service, store } = buildService();
    await service.createMethod({
      code: "MANUAL_FLAT",
      name: "Flat",
      providerKind: "manual",
      flatRate: { amount: "15000", currency: "IDR" },
    });
    const f = await service.createFulfillmentForOrder("ord_1", {
      methodCode: "MANUAL_FLAT",
    });
    return { service, store, fulfillment: f };
  }

  const STAFF: { kind: "staff"; userId: string } = {
    kind: "staff",
    userId: "usr_a",
  };

  it("markShipped transitions pending → shipped, sets trackedAt + tracking, audits, and emits", async () => {
    const { service, store, fulfillment } = await setup();
    const { events: bus } = await import(
      "../../../src/modules/shipping/events.js"
    );
    bus.clear();
    const fired: string[] = [];
    bus.on("fulfillment.shipped", (p) => {
      fired.push(`shipped:${p.trackingCode ?? "none"}`);
    });
    bus.on("fulfillment.status_changed", (p) => {
      fired.push(`changed:${p.toStatus}`);
    });

    const updated = await service.markShipped(fulfillment.id, {
      actor: STAFF,
      trackingCode: "JNE-12345",
    });
    expect(updated.status).toBe("shipped");
    expect(updated.trackingCode).toBe("JNE-12345");
    expect(updated.trackedAt).not.toBeNull();
    expect(updated.deliveredAt).toBeNull();

    expect(fired).toEqual(["shipped:JNE-12345", "changed:shipped"]);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]!.action).toBe("fulfillment_mark_shipped");
    expect(store.auditEvents[0]!.actorKind).toBe("staff");
  });

  it("markDelivered transitions shipped → delivered, sets deliveredAt, emits", async () => {
    const { service, store, fulfillment } = await setup();
    await service.markShipped(fulfillment.id, { actor: STAFF });
    const { events: bus } = await import(
      "../../../src/modules/shipping/events.js"
    );
    bus.clear();
    const fired: string[] = [];
    bus.on("fulfillment.delivered", (p) => {
      fired.push(`delivered:${p.fulfillmentId}`);
    });

    const updated = await service.markDelivered(fulfillment.id, {
      actor: STAFF,
    });
    expect(updated.status).toBe("delivered");
    expect(updated.deliveredAt).not.toBeNull();
    expect(fired).toContain(`delivered:${fulfillment.id}`);
    expect(
      store.auditEvents.some((e) => e.action === "fulfillment_mark_delivered"),
    ).toBe(true);
  });

  it("cancel transitions pending → cancelled with a captured reason", async () => {
    const { service, store, fulfillment } = await setup();
    const updated = await service.cancel(fulfillment.id, {
      actor: STAFF,
      reason: "operator-error",
    });
    expect(updated.status).toBe("cancelled");
    const cancelEvent = store.auditEvents.find(
      (e) => e.action === "fulfillment_cancel",
    );
    expect(cancelEvent?.reason).toBe("operator-error");
  });

  it("cancel from shipped is also allowed", async () => {
    const { service, fulfillment } = await setup();
    await service.markShipped(fulfillment.id, { actor: STAFF });
    const updated = await service.cancel(fulfillment.id, {
      actor: STAFF,
      reason: null,
    });
    expect(updated.status).toBe("cancelled");
  });

  it("rejects illegal transitions with invalid_transition", async () => {
    const { service, fulfillment } = await setup();
    // pending → delivered is not allowed; must go via shipped.
    await expect(
      service.markDelivered(fulfillment.id, { actor: STAFF }),
    ).rejects.toMatchObject({ details: { code: "invalid_transition" } });
  });

  it("rejects transitions out of a terminal status", async () => {
    const { service, fulfillment } = await setup();
    await service.cancel(fulfillment.id, { actor: STAFF, reason: null });
    await expect(
      service.markShipped(fulfillment.id, { actor: STAFF }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("setTracking updates the code without changing status", async () => {
    const { service, fulfillment } = await setup();
    const updated = await service.setTracking(fulfillment.id, {
      actor: STAFF,
      trackingCode: "ABC-999",
    });
    expect(updated.status).toBe("pending");
    expect(updated.trackingCode).toBe("ABC-999");
  });

  it("setTracking with null clears the code", async () => {
    const { service, fulfillment } = await setup();
    await service.setTracking(fulfillment.id, {
      actor: STAFF,
      trackingCode: "ABC-999",
    });
    const cleared = await service.setTracking(fulfillment.id, {
      actor: STAFF,
      trackingCode: null,
    });
    expect(cleared.trackingCode).toBeNull();
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

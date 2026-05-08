/**
 * Orders service — unit tests against in-memory fakes.
 *
 * Same pattern as the cart/customer/checkout tests. We construct
 * `OrderServiceImpl` with a fake `OrdersRepository` backed by `Map`s
 * for every table and a small set of seeded variants.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { events } from "../../../src/modules/orders/events.js";
import { OrderServiceImpl } from "../../../src/modules/orders/service.js";
import type {
  OrderListFilters,
  OrderListResult,
  OrderUpdatePatch,
  OrdersRepository,
  VariantWithProduct,
} from "../../../src/modules/orders/repository.js";
import type {
  NewOrderItemRow,
  NewOrderRow,
  NewOrderStatusHistoryRow,
  OrderIntentRow,
  OrderItemRow,
  OrderRow,
  OrderStatusHistoryRow,
  ProductRow,
  ProductVariantRow,
} from "../../../src/db/schema/index.js";
import { ConflictError, NotFoundError } from "../../../src/lib/errors.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

interface FakeStore {
  orders: Map<string, OrderRow>;
  items: OrderItemRow[];
  history: OrderStatusHistoryRow[];
  intents: Map<string, OrderIntentRow>;
  variants: Map<string, VariantWithProduct>;
  /**
   * In-memory stand-in for the four region tables. The orders service
   * resolves names against this map at write time so the snapshot is
   * self-contained — same shape as the production query.
   */
  regionNames: Map<string, string>;
  sequence: number;
  clock: number;
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(NOW.getTime() + store.clock * 1000);
}

function createStore(): FakeStore {
  return {
    orders: new Map(),
    items: [],
    history: [],
    intents: new Map(),
    variants: new Map(),
    regionNames: new Map(),
    sequence: 100000,
    clock: 0,
  };
}

function makeIntent(
  overrides: Partial<OrderIntentRow> & { id: string; checkoutId: string },
): OrderIntentRow {
  return {
    id: overrides.id,
    checkoutId: overrides.checkoutId,
    cartSnapshot: overrides.cartSnapshot ?? [
      {
        variantId: "var_1",
        quantity: 2,
        unitPrice: { amount: "250000", currency: "IDR" },
      },
    ],
    totalsSnapshot: overrides.totalsSnapshot ?? {
      subtotal: { amount: "500000", currency: "IDR" },
      tax: { amount: "55000", currency: "IDR" },
      shipping: { amount: "10000", currency: "IDR" },
      total: { amount: "565000", currency: "IDR" },
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

function makeVariant(id: string, productId: string): VariantWithProduct {
  const variant: ProductVariantRow = {
    id,
    productId,
    sku: `SKU-${id.toUpperCase()}`,
    translations: { id: { title: `Varian ${id}` }, en: { title: `Variant ${id}` } },
    priceAmount: 250_000n,
    priceCurrency: "IDR",
    compareAtAmount: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  const product: ProductRow = {
    id: productId,
    slug: `product-${productId}`,
    translations: {
      id: { title: `Produk ${productId}` },
      en: { title: `Product ${productId}` },
    },
    status: "active",
    defaultCurrency: "IDR",
    imageUrl: null,
    imageAlt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  return { variant, product };
}

function createFakeRepo(store: FakeStore): OrdersRepository {
  const repo: OrdersRepository = {
    async nextOrderNumber(): Promise<number> {
      const value = store.sequence;
      store.sequence += 1;
      return value;
    },
    async insertOrder(row: NewOrderRow): Promise<OrderRow> {
      const now = tick(store);
      const order: OrderRow = {
        id: row.id,
        orderNumber: row.orderNumber,
        customerId: row.customerId ?? null,
        email: row.email,
        currency: row.currency,
        status: row.status ?? "pending_payment",
        subtotalAmount: row.subtotalAmount,
        taxAmount: row.taxAmount ?? 0n,
        taxRateCode: row.taxRateCode ?? null,
        taxRateBasisPoints: row.taxRateBasisPoints ?? null,
        shippingAmount: row.shippingAmount ?? 0n,
        shippingMethodCode: row.shippingMethodCode,
        totalAmount: row.totalAmount,
        shippingAddressSnapshot: row.shippingAddressSnapshot as object,
        billingAddressSnapshot: (row.billingAddressSnapshot as object) ?? null,
        paymentMethod: row.paymentMethod,
        paidAt: row.paidAt ?? null,
        fulfilledAt: row.fulfilledAt ?? null,
        cancelledAt: row.cancelledAt ?? null,
        refundedAt: row.refundedAt ?? null,
        cancellationReason: row.cancellationReason ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.orders.set(order.id, order);
      return order;
    },
    async getOrderById(id) {
      return store.orders.get(id) ?? null;
    },
    async getOrderByNumber(orderNumber) {
      for (const o of store.orders.values()) {
        if (o.orderNumber === orderNumber) return o;
      }
      return null;
    },
    async getOrderByIdForUpdate(id) {
      return store.orders.get(id) ?? null;
    },
    async getOrderByIntentId(orderIntentId) {
      for (const event of store.history) {
        const details = (event.details ?? {}) as { orderIntentId?: string };
        if (details.orderIntentId === orderIntentId) {
          return store.orders.get(event.orderId) ?? null;
        }
      }
      return null;
    },
    async getOrderByCheckoutId(checkoutId) {
      for (const event of store.history) {
        const details = (event.details ?? {}) as { checkoutId?: string };
        if (details.checkoutId === checkoutId) {
          return store.orders.get(event.orderId) ?? null;
        }
      }
      return null;
    },
    async listOrders(filters: OrderListFilters): Promise<OrderListResult> {
      let rows = [...store.orders.values()];
      if (filters.status) rows = rows.filter((r) => r.status === filters.status);
      if (filters.customerId)
        rows = rows.filter((r) => r.customerId === filters.customerId);
      if (filters.email) rows = rows.filter((r) => r.email === filters.email);
      if (filters.orderNumber)
        rows = rows.filter((r) => r.orderNumber === filters.orderNumber);
      if (filters.createdFrom) {
        const from = filters.createdFrom.getTime();
        rows = rows.filter((r) => r.createdAt.getTime() >= from);
      }
      if (filters.createdTo) {
        const to = filters.createdTo.getTime();
        rows = rows.filter((r) => r.createdAt.getTime() <= to);
      }
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(start, start + filters.pageSize), total };
    },
    async listCustomerOrders(
      customerId,
      page,
      pageSize,
    ): Promise<OrderListResult> {
      const rows = [...store.orders.values()].filter(
        (r) => r.customerId === customerId,
      );
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (page - 1) * pageSize;
      return { rows: rows.slice(start, start + pageSize), total };
    },
    async updateOrder(id, patch: OrderUpdatePatch) {
      const existing = store.orders.get(id);
      if (!existing) return null;
      const updated: OrderRow = {
        ...existing,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.paidAt !== undefined ? { paidAt: patch.paidAt } : {}),
        ...(patch.fulfilledAt !== undefined
          ? { fulfilledAt: patch.fulfilledAt }
          : {}),
        ...(patch.cancelledAt !== undefined
          ? { cancelledAt: patch.cancelledAt }
          : {}),
        ...(patch.refundedAt !== undefined
          ? { refundedAt: patch.refundedAt }
          : {}),
        ...(patch.cancellationReason !== undefined
          ? { cancellationReason: patch.cancellationReason }
          : {}),
        updatedAt: tick(store),
      };
      store.orders.set(id, updated);
      return updated;
    },
    async insertOrderItems(rows: NewOrderItemRow[]): Promise<OrderItemRow[]> {
      const inserted: OrderItemRow[] = rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        variantId: row.variantId,
        sku: row.sku,
        titleTranslations: row.titleTranslations as object,
        quantity: row.quantity,
        unitPriceAmount: row.unitPriceAmount,
        unitPriceCurrency: row.unitPriceCurrency,
        lineSubtotalAmount: row.lineSubtotalAmount,
        createdAt: tick(store),
      }));
      store.items.push(...inserted);
      return inserted;
    },
    async listItemsForOrder(orderId) {
      return store.items.filter((it) => it.orderId === orderId);
    },
    async listItemsForOrders(orderIds) {
      const set = new Set(orderIds);
      return store.items.filter((it) => set.has(it.orderId));
    },
    async insertStatusHistory(
      row: NewOrderStatusHistoryRow,
    ): Promise<OrderStatusHistoryRow> {
      const inserted: OrderStatusHistoryRow = {
        id: row.id,
        orderId: row.orderId,
        fromStatus: row.fromStatus ?? null,
        toStatus: row.toStatus,
        actorKind: row.actorKind,
        actorId: row.actorId ?? null,
        details: (row.details as Record<string, unknown>) ?? {},
        createdAt: tick(store),
      };
      store.history.push(inserted);
      return inserted;
    },
    async listStatusHistory(orderId) {
      return store.history
        .filter((h) => h.orderId === orderId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async getOrderIntentById(id) {
      return store.intents.get(id) ?? null;
    },
    async getVariantsWithProductsByIds(variantIds) {
      const out: VariantWithProduct[] = [];
      for (const id of variantIds) {
        const v = store.variants.get(id);
        if (v) out.push(v);
      }
      return out;
    },
    async resolveRegionNames(input) {
      // Stand-in for the four-LEFT-JOIN read; an unseeded id resolves to
      // `null`, matching the production behaviour for a stale FK.
      return {
        provinsiName: store.regionNames.get(input.provinsiId) ?? null,
        kotaKabupatenName:
          store.regionNames.get(input.kotaKabupatenId) ?? null,
        kecamatanName: store.regionNames.get(input.kecamatanId) ?? null,
        kelurahanName: input.kelurahanId
          ? store.regionNames.get(input.kelurahanId) ?? null
          : null,
      };
    },
    async withTransaction(fn) {
      // No real transactional semantics in the fake — the orders
      // service relies on the repo for isolation; tests assert at the
      // orchestration level.
      return fn(repo);
    },
  };
  return repo;
}

interface BuildResult {
  store: FakeStore;
  service: OrderServiceImpl;
}

function buildService(): BuildResult {
  const store = createStore();
  store.variants.set("var_1", makeVariant("var_1", "prod_1"));
  store.variants.set("var_2", makeVariant("var_2", "prod_2"));

  // Region names for the canonical Jakarta address used by the default
  // intent fixture. The orders service resolves these at write time and
  // freezes them into the order's JSONB snapshot.
  store.regionNames.set("31", "DKI Jakarta");
  store.regionNames.set("3171", "Jakarta Pusat");
  store.regionNames.set("317101", "Gambir");

  // Seed an order intent the tests use as the canonical input.
  const intent = makeIntent({ id: "oint_1", checkoutId: "chk_1" });
  store.intents.set(intent.id, intent);

  const repo = createFakeRepo(store);
  const service = new OrderServiceImpl(repo);
  return { store, service };
}

beforeEach(() => {
  events.clear();
});

// ---------------------------------------------------------------------------
// createFromIntent
// ---------------------------------------------------------------------------

describe("createFromIntent", () => {
  it("materialises an order, line items, initial history, and emits order.placed", async () => {
    const { service, store } = buildService();

    const placed: string[] = [];
    events.on("order.placed", (p) => {
      placed.push(p.orderId);
    });

    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });

    expect(order.status).toBe("pending_payment");
    expect(order.orderNumber).toMatch(/^ORD-\d{4}-\d{6}$/);
    expect(order.email).toBe("buyer@example.com");
    expect(order.currency).toBe("IDR");
    expect(order.subtotal.amount).toBe(500_000n);
    expect(order.tax.amount).toBe(55_000n);
    expect(order.shipping.amount).toBe(10_000n);
    expect(order.total.amount).toBe(565_000n);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.variantId).toBe("var_1");
    expect(order.items[0]!.quantity).toBe(2);
    expect(order.items[0]!.unitPrice.amount).toBe(250_000n);
    expect(order.items[0]!.lineSubtotal.amount).toBe(500_000n);
    expect(order.items[0]!.title).toBe("Varian var_1");

    // The initial status-history row carries `from_status: null`.
    expect(store.history).toHaveLength(1);
    expect(store.history[0]!.fromStatus).toBeNull();
    expect(store.history[0]!.toStatus).toBe("pending_payment");
    expect(store.history[0]!.actorKind).toBe("customer");

    expect(placed).toContain(order.id);
  });

  it("freezes the tax-rate metadata from the totals snapshot onto the order row", async () => {
    // The checkout module captures the rate that produced `tax` on the
    // intent's totalsSnapshot. The orders service forwards it onto the
    // permanent order row so the wire shape can render "PPN 11%" and so
    // audit code can recompute the tax later.
    const { service, store } = buildService();
    const intent = makeIntent({
      id: "oint_with_rate",
      checkoutId: "chk_with_rate",
      totalsSnapshot: {
        subtotal: { amount: "100000", currency: "IDR" },
        tax: { amount: "11000", currency: "IDR" },
        shipping: { amount: "10000", currency: "IDR" },
        total: { amount: "121000", currency: "IDR" },
        // The new rate-metadata fields the checkout snapshot now carries.
        taxRateCode: "PPN_11",
        taxRateBasisPoints: 1100,
      } as unknown as OrderIntentRow["totalsSnapshot"],
    });
    store.intents.set(intent.id, intent);

    const order = await service.createFromIntent("oint_with_rate", {
      actorKind: "customer",
    });

    expect(order.tax.amount).toBe(11_000n);
    expect(order.taxRateCode).toBe("PPN_11");
    expect(order.taxRateBasisPoints).toBe(1100);
  });

  it("frozen taxRate is null when the snapshot has no rate metadata (env-var fallback path)", async () => {
    // Older snapshots written before the rate metadata landed (or the
    // env-var fallback path inside getTotals) carry no `taxRateCode`.
    // The order row preserves null rather than fabricating a code.
    const { service } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });
    expect(order.taxRateCode).toBeNull();
    expect(order.taxRateBasisPoints).toBeNull();
  });

  it("rejects a duplicate intent with intent_already_consumed", async () => {
    const { service } = buildService();
    await service.createFromIntent("oint_1", { actorKind: "customer" });

    await expect(
      service.createFromIntent("oint_1", { actorKind: "customer" }),
    ).rejects.toMatchObject({
      details: { code: "intent_already_consumed" },
    });
  });

  it("rejects an unknown intent with NotFoundError", async () => {
    const { service } = buildService();
    await expect(
      service.createFromIntent("oint_does_not_exist", {
        actorKind: "customer",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Snapshot region-name enrichment
//
// Names are resolved AT WRITE TIME (immutable history). The frozen blob
// keeps the names that were valid the day the order was placed even if
// the BPS dataset later renames a region.
// ---------------------------------------------------------------------------

describe("address snapshot region-name enrichment", () => {
  it("populates the four region names alongside the BPS ids on the shipping snapshot", async () => {
    const { service, store } = buildService();
    // Add a kelurahan id to the canonical intent and seed its name.
    const intent = makeIntent({
      id: "oint_named",
      checkoutId: "chk_named",
      shippingAddressSnapshot: {
        id: "adr_ship_named",
        customerId: "cust_a",
        kind: "shipping",
        recipientName: "Sari",
        phone: "+6281234567890",
        addressLine1: "Jl. Mawar 1",
        addressLine2: null,
        provinsiId: "31",
        kotaKabupatenId: "3171",
        kecamatanId: "317101",
        kelurahanId: "3171011001",
        postalCode: "10110",
        notes: null,
      },
    });
    store.intents.set(intent.id, intent);
    store.regionNames.set("3171011001", "Gambir");

    const order = await service.createFromIntent(intent.id, {
      actorKind: "customer",
    });

    expect(order.shippingAddressSnapshot.provinsiName).toBe("DKI Jakarta");
    expect(order.shippingAddressSnapshot.kotaKabupatenName).toBe(
      "Jakarta Pusat",
    );
    expect(order.shippingAddressSnapshot.kecamatanName).toBe("Gambir");
    expect(order.shippingAddressSnapshot.kelurahanName).toBe("Gambir");
    // BPS ids remain alongside the names.
    expect(order.shippingAddressSnapshot.provinsiId).toBe("31");
    expect(order.shippingAddressSnapshot.kotaKabupatenId).toBe("3171");
  });

  it("omits the kelurahan name when the source snapshot has no kelurahan id", async () => {
    // The default intent fixture omits kelurahan — exercise that path.
    const { service } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });

    expect(order.shippingAddressSnapshot.provinsiName).toBe("DKI Jakarta");
    expect(order.shippingAddressSnapshot.kelurahanName).toBeUndefined();
    expect(order.shippingAddressSnapshot.kelurahanId).toBeNull();
  });

  it("omits a single name when its region row is unknown without dropping the others", async () => {
    const { service, store } = buildService();
    // Override one id (kecamatan) to point at a region the seed does not
    // know — the orders service should still capture the other three names.
    const intent = makeIntent({
      id: "oint_partial",
      checkoutId: "chk_partial",
      shippingAddressSnapshot: {
        id: "adr_ship_partial",
        customerId: "cust_a",
        kind: "shipping",
        recipientName: "Anonymous",
        phone: "+6281234567890",
        addressLine1: "Jl. Stale 1",
        addressLine2: null,
        provinsiId: "31",
        kotaKabupatenId: "3171",
        kecamatanId: "999999",
        kelurahanId: null,
        postalCode: "10110",
        notes: null,
      },
    });
    store.intents.set(intent.id, intent);

    const order = await service.createFromIntent(intent.id, {
      actorKind: "customer",
    });

    expect(order.shippingAddressSnapshot.provinsiName).toBe("DKI Jakarta");
    expect(order.shippingAddressSnapshot.kotaKabupatenName).toBe(
      "Jakarta Pusat",
    );
    expect(order.shippingAddressSnapshot.kecamatanName).toBeUndefined();
    expect(order.shippingAddressSnapshot.kecamatanId).toBe("999999");
  });
});

// ---------------------------------------------------------------------------
// transitionStatus
// ---------------------------------------------------------------------------

describe("transitionStatus", () => {
  it("transitions pending_payment → paid, denormalises paid_at, appends history, and emits", async () => {
    const { service, store } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });

    const fired: string[] = [];
    events.on("order.paid", (p) => {
      fired.push(p.orderId);
    });
    events.on("order.status_changed", (p) => {
      fired.push(`changed:${p.toStatus}`);
    });

    const updated = await service.transitionStatus(order.id, "paid", {
      actorKind: "system",
      details: { providerReference: "MID-123" },
    });
    expect(updated.status).toBe("paid");
    expect(updated.paidAt).not.toBeNull();
    expect(store.history).toHaveLength(2);
    expect(store.history[1]!.fromStatus).toBe("pending_payment");
    expect(store.history[1]!.toStatus).toBe("paid");
    expect(store.history[1]!.actorKind).toBe("system");
    expect(store.history[1]!.details).toMatchObject({
      providerReference: "MID-123",
    });

    expect(fired).toContain(order.id);
    expect(fired).toContain("changed:paid");
  });

  it("rejects an invalid transition with invalid_transition", async () => {
    const { service } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });
    await expect(
      service.transitionStatus(order.id, "fulfilled", {
        actorKind: "staff",
        actorId: "usr_a",
      }),
    ).rejects.toMatchObject({ details: { code: "invalid_transition" } });
  });

  it("refuses to transition out of a terminal state", async () => {
    const { service } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });
    await service.cancelOrder(order.id, {
      actorKind: "staff",
      actorId: "usr_a",
      reason: "test",
    });
    await expect(
      service.transitionStatus(order.id, "paid", { actorKind: "system" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// cancelOrder
// ---------------------------------------------------------------------------

describe("cancelOrder", () => {
  it("transitions to cancelled, sets cancelled_at + reason, emits order.cancelled", async () => {
    const { service, store } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });

    const captured: Array<{ id: string; reason: string | null }> = [];
    events.on("order.cancelled", (p) => {
      captured.push({ id: p.orderId, reason: p.reason });
    });

    const cancelled = await service.cancelOrder(order.id, {
      actorKind: "staff",
      actorId: "usr_a",
      reason: "  buyer changed mind  ",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancellationReason).toBe("buyer changed mind");
    expect(store.history.at(-1)!.toStatus).toBe("cancelled");
    expect(captured).toEqual([
      { id: order.id, reason: "buyer changed mind" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// listCustomerOrders cross-tenant 404 protection
// ---------------------------------------------------------------------------

describe("listCustomerOrders / getOrderByNumber cross-tenant safety", () => {
  it("returns the order via byNumber only to its owning customer", async () => {
    const { service, store } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });
    // Manually attach a customer id to the order for this scenario —
    // the createFromIntent path leaves customerId null in v0.1 because
    // the order_intent does not carry it through.
    const row = store.orders.get(order.id)!;
    store.orders.set(order.id, { ...row, customerId: "cust_a" });

    const owner = await service.getOrderByNumber(order.orderNumber);
    expect(owner?.customerId).toBe("cust_a");

    // listCustomerOrders for a different customer must return zero
    // rows even though the order exists.
    const stranger = await service.listCustomerOrders(
      "cust_other",
      { page: 1, pageSize: 20 },
    );
    expect(stranger.total).toBe(0);
    expect(stranger.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Locale handling at the read boundary
// ---------------------------------------------------------------------------

describe("locale resolution on item titles", () => {
  it("resolves to the requested locale, falling back to default", async () => {
    const { service } = buildService();
    const order = await service.createFromIntent("oint_1", {
      actorKind: "customer",
    });

    const en = await service.getOrderById(order.id, { locale: "en" });
    expect(en?.items[0]!.title).toBe("Variant var_1");

    const id = await service.getOrderById(order.id, { locale: "id" });
    expect(id?.items[0]!.title).toBe("Varian var_1");

    // Unknown locale falls back to the default ("id").
    const unknown = await service.getOrderById(order.id, { locale: "fr" });
    expect(unknown?.items[0]!.title).toBe("Varian var_1");
  });
});

// ---------------------------------------------------------------------------
// listOrders — orderNumber filter (paired with the new ?orderNumber= query)
// ---------------------------------------------------------------------------

describe("listOrders — orderNumber filter", () => {
  // Seed two orders with deterministic numbers so we can target one
  // exactly. We re-key the underlying rows (rather than relying on the
  // sequence allocator) because the sequence advances per call and we
  // want stable handles to assert against.
  function seedTwoOrders(store: FakeStore, service: OrderServiceImpl) {
    return Promise.all([
      service.createFromIntent("oint_1", { actorKind: "customer" }),
      (async () => {
        // The second intent is created on the fly so the test does not
        // depend on a second seeded entry in `buildService`.
        const intent = makeIntent({ id: "oint_2", checkoutId: "chk_2" });
        store.intents.set(intent.id, intent);
        return service.createFromIntent("oint_2", { actorKind: "customer" });
      })(),
    ]);
  }

  it("returns the single matching row when the filter is set", async () => {
    const { service, store } = buildService();
    const [, second] = await seedTwoOrders(store, service);

    const result = await service.listOrders({
      orderNumber: second.orderNumber,
      page: 1,
      pageSize: 20,
    });

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.orderNumber).toBe(second.orderNumber);
  });

  it("returns zero rows for an order number that does not exist", async () => {
    const { service, store } = buildService();
    await seedTwoOrders(store, service);

    const result = await service.listOrders({
      orderNumber: "ORD-1999-999999",
      page: 1,
      pageSize: 20,
    });
    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it("composes with the status filter (both must match)", async () => {
    const { service, store } = buildService();
    const [first, second] = await seedTwoOrders(store, service);

    // Move only the first order to `paid` so a {orderNumber: second,
    // status: "paid"} query must return zero, and {orderNumber: first,
    // status: "paid"} must return one.
    await service.transitionStatus(first.id, "paid", { actorKind: "system" });

    const noMatch = await service.listOrders({
      orderNumber: second.orderNumber,
      status: "paid",
      page: 1,
      pageSize: 20,
    });
    expect(noMatch.total).toBe(0);

    const match = await service.listOrders({
      orderNumber: first.orderNumber,
      status: "paid",
      page: 1,
      pageSize: 20,
    });
    expect(match.total).toBe(1);
    expect(match.data[0]!.orderNumber).toBe(first.orderNumber);
  });
});

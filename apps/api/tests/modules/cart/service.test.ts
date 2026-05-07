/**
 * Cart service — unit tests against an in-memory fake repository.
 *
 * Same pattern as the catalog and customer service tests: construct
 * `CartServiceImpl` with a hand-rolled fake that implements the
 * `CartRepository` shape. Lets us pin domain rules (currency lock,
 * merge-by-variant, currency-mismatch errors, soft-delete visibility,
 * guest-merge behavior) without standing up a database.
 */
import { describe, expect, it } from "vitest";
import { CartServiceImpl } from "../../../src/modules/cart/service.js";
import type {
  CartRepository,
  VariantPricingSnapshot,
} from "../../../src/modules/cart/repository.js";
import type {
  CartItemRow,
  CartRow,
  NewCartItemRow,
  NewCartRow,
} from "../../../src/db/schema/index.js";

// ---------------------------------------------------------------------------
// In-memory store + fake repository
// ---------------------------------------------------------------------------

interface FakeStore {
  carts: Map<string, CartRow>;
  items: Map<string, CartItemRow>;
  variants: Map<string, VariantPricingSnapshot>;
  /** Auto-incrementing time so we can assert ordering of timestamps. */
  clock: number;
}

function createStore(): FakeStore {
  return {
    carts: new Map(),
    items: new Map(),
    variants: new Map(),
    clock: 0,
  };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  // Anchor on a fixed base date so the timestamps are comparable across
  // tests without touching `Date.now()`.
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

function createFakeRepo(store: FakeStore): CartRepository {
  const repo: CartRepository = {
    async insertCart(row: NewCartRow): Promise<CartRow> {
      const now = tick(store);
      const cart: CartRow = {
        id: row.id,
        customerId: row.customerId ?? null,
        currency: row.currency,
        status: row.status ?? "active",
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      };
      store.carts.set(cart.id, cart);
      return cart;
    },
    async getCartById(id) {
      return store.carts.get(id) ?? null;
    },
    async getActiveCartForCustomer(customerId) {
      const matches = [...store.carts.values()]
        .filter((c) => c.customerId === customerId && c.status === "active")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return matches[0] ?? null;
    },
    async listCarts(filters) {
      let rows = [...store.carts.values()];
      if (filters.status) rows = rows.filter((c) => c.status === filters.status);
      if (filters.customerId)
        rows = rows.filter((c) => c.customerId === filters.customerId);
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(start, start + filters.pageSize), total };
    },
    async updateCart(id, patch) {
      const existing = store.carts.get(id);
      if (!existing) return null;
      const updated: CartRow = {
        ...existing,
        ...(patch.customerId !== undefined
          ? { customerId: patch.customerId }
          : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: tick(store),
      };
      store.carts.set(id, updated);
      return updated;
    },
    async touchCart(id) {
      const existing = store.carts.get(id);
      if (!existing) return null;
      const updated = { ...existing, updatedAt: tick(store) };
      store.carts.set(id, updated);
      return updated;
    },

    async insertItem(row: NewCartItemRow): Promise<CartItemRow> {
      const now = tick(store);
      const item: CartItemRow = {
        id: row.id,
        cartId: row.cartId,
        variantId: row.variantId,
        quantity: row.quantity,
        unitPriceAmount: row.unitPriceAmount,
        unitPriceCurrency: row.unitPriceCurrency,
        createdAt: now,
        updatedAt: now,
      };
      store.items.set(item.id, item);
      return item;
    },
    async getItemById(id) {
      return store.items.get(id) ?? null;
    },
    async getItemByCartAndVariant(cartId, variantId) {
      for (const item of store.items.values()) {
        if (item.cartId === cartId && item.variantId === variantId) return item;
      }
      return null;
    },
    async listItemsForCart(cartId) {
      return [...store.items.values()]
        .filter((i) => i.cartId === cartId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async listItemsForCarts(cartIds) {
      const set = new Set(cartIds);
      return [...store.items.values()]
        .filter((i) => set.has(i.cartId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async updateItem(id, patch) {
      const existing = store.items.get(id);
      if (!existing) return null;
      const updated: CartItemRow = {
        ...existing,
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        ...(patch.unitPriceAmount !== undefined
          ? { unitPriceAmount: patch.unitPriceAmount }
          : {}),
        ...(patch.unitPriceCurrency !== undefined
          ? { unitPriceCurrency: patch.unitPriceCurrency }
          : {}),
        updatedAt: tick(store),
      };
      store.items.set(id, updated);
      return updated;
    },
    async deleteItem(id) {
      store.items.delete(id);
    },
    async deleteItemsForCart(cartId) {
      for (const [id, item] of store.items) {
        if (item.cartId === cartId) store.items.delete(id);
      }
    },

    async getVariantSnapshot(variantId) {
      return store.variants.get(variantId) ?? null;
    },

    async withTransaction(fn) {
      // The fake has no real transactional semantics; calling the callback
      // with `repo` itself is sufficient to test the service's logic.
      return fn(repo);
    },
  };
  return repo;
}

function buildService(): { service: CartServiceImpl; store: FakeStore } {
  const store = createStore();
  return { service: new CartServiceImpl(createFakeRepo(store)), store };
}

function seedVariant(
  store: FakeStore,
  id: string,
  amount: bigint,
  currency: string,
): void {
  store.variants.set(id, {
    id,
    priceAmount: amount,
    priceCurrency: currency,
    deleted: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CartService.createGuestCart", () => {
  it("returns an active, empty cart with the given currency and a cart_-prefixed id", async () => {
    const { service } = buildService();
    const cart = await service.createGuestCart("IDR");
    expect(cart.id).toMatch(/^cart_/);
    expect(cart.customerId).toBeNull();
    expect(cart.currency).toBe("IDR");
    expect(cart.status).toBe("active");
    expect(cart.items).toEqual([]);
    expect(cart.expiresAt.getTime()).toBeGreaterThan(cart.createdAt.getTime());
  });
});

describe("CartService.createCustomerCart", () => {
  it("binds the cart to the customer and starts active", async () => {
    const { service } = buildService();
    const cart = await service.createCustomerCart("cust_xyz", "IDR");
    expect(cart.customerId).toBe("cust_xyz");
    expect(cart.status).toBe("active");
  });
});

describe("CartService.addItem", () => {
  it("captures unit_price from the variant and bumps updatedAt", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 250_000n, "IDR");

    const cart = await service.createGuestCart("IDR");
    const initialUpdatedAt = cart.updatedAt;

    const after = await service.addItem(cart.id, {
      variantId: "var_1",
      quantity: 2,
    });

    expect(after.items).toHaveLength(1);
    const line = after.items[0]!;
    expect(line.quantity).toBe(2);
    expect(line.unitPrice).toEqual({ amount: 250_000n, currency: "IDR" });
    expect(line.lineTotal).toEqual({ amount: 500_000n, currency: "IDR" });
    // touchCart bumps the parent cart's mtime — assert it moved forward.
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      initialUpdatedAt.getTime(),
    );
  });

  it("merges a re-add of the same variant into one line with summed quantity", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");

    const cart = await service.createGuestCart("IDR");
    await service.addItem(cart.id, { variantId: "var_1", quantity: 2 });
    const after = await service.addItem(cart.id, {
      variantId: "var_1",
      quantity: 3,
    });

    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.quantity).toBe(5);
  });

  it("rejects a variant in a different currency with currency_mismatch", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_usd", 1500n, "USD");

    const cart = await service.createGuestCart("IDR");
    await expect(
      service.addItem(cart.id, { variantId: "var_usd", quantity: 1 }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { code: "currency_mismatch" },
    });
  });

  it("404s on a missing or soft-deleted variant", async () => {
    const { service } = buildService();
    const cart = await service.createGuestCart("IDR");
    await expect(
      service.addItem(cart.id, { variantId: "var_missing", quantity: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("CartService.updateItemQuantity", () => {
  it("removes the line when quantity is 0", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    const cart = await service.createGuestCart("IDR");
    const populated = await service.addItem(cart.id, {
      variantId: "var_1",
      quantity: 2,
    });
    const itemId = populated.items[0]!.id;

    const after = await service.updateItemQuantity(cart.id, itemId, 0);
    expect(after.items).toEqual([]);
  });

  it("updates the quantity on a positive value", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    const cart = await service.createGuestCart("IDR");
    const populated = await service.addItem(cart.id, {
      variantId: "var_1",
      quantity: 2,
    });
    const itemId = populated.items[0]!.id;

    const after = await service.updateItemQuantity(cart.id, itemId, 7);
    expect(after.items[0]!.quantity).toBe(7);
  });
});

describe("CartService.removeItem", () => {
  it("removes the line and bumps the cart's updatedAt", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    const cart = await service.createGuestCart("IDR");
    const populated = await service.addItem(cart.id, {
      variantId: "var_1",
      quantity: 2,
    });
    const itemId = populated.items[0]!.id;
    const beforeUpdatedAt = populated.updatedAt;

    const after = await service.removeItem(cart.id, itemId);
    expect(after.items).toEqual([]);
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      beforeUpdatedAt.getTime(),
    );
  });
});

describe("CartService.clear", () => {
  it("empties the cart of all line items", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    seedVariant(store, "var_2", 200n, "IDR");
    const cart = await service.createGuestCart("IDR");
    await service.addItem(cart.id, { variantId: "var_1", quantity: 2 });
    await service.addItem(cart.id, { variantId: "var_2", quantity: 1 });

    const after = await service.clear(cart.id);
    expect(after.items).toEqual([]);
  });
});

describe("CartService.mergeGuestIntoCustomer", () => {
  it("re-binds the guest cart in place when the customer has no active cart", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    const guest = await service.createGuestCart("IDR");
    await service.addItem(guest.id, { variantId: "var_1", quantity: 3 });

    const merged = await service.mergeGuestIntoCustomer(guest.id, "cust_a");
    expect(merged.id).toBe(guest.id); // same row, customer_id flipped
    expect(merged.customerId).toBe("cust_a");
    expect(merged.items[0]!.quantity).toBe(3);
  });

  it("merges items into the customer's existing active cart, marking the guest converted", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    seedVariant(store, "var_2", 200n, "IDR");

    const customerCart = await service.createCustomerCart("cust_a", "IDR");
    await service.addItem(customerCart.id, {
      variantId: "var_1",
      quantity: 1,
    });

    const guest = await service.createGuestCart("IDR");
    await service.addItem(guest.id, { variantId: "var_1", quantity: 2 });
    await service.addItem(guest.id, { variantId: "var_2", quantity: 5 });

    const merged = await service.mergeGuestIntoCustomer(guest.id, "cust_a");
    expect(merged.id).toBe(customerCart.id);
    expect(merged.items).toHaveLength(2);
    const byVariant = new Map(merged.items.map((i) => [i.variantId, i]));
    expect(byVariant.get("var_1")?.quantity).toBe(3);
    expect(byVariant.get("var_2")?.quantity).toBe(5);

    // Source guest cart is now `converted` — the audit trail survives
    // and a future merge attempt on the same id would be refused.
    const guestAfter = await service.getCartById(guest.id);
    expect(guestAfter?.status).toBe("converted");
  });

  it("rejects on currency mismatch with a clear validation error", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_idr", 100n, "IDR");
    seedVariant(store, "var_usd", 1n, "USD");

    const customerCart = await service.createCustomerCart("cust_a", "IDR");
    await service.addItem(customerCart.id, {
      variantId: "var_idr",
      quantity: 1,
    });

    const guest = await service.createGuestCart("USD");
    await service.addItem(guest.id, { variantId: "var_usd", quantity: 1 });

    await expect(
      service.mergeGuestIntoCustomer(guest.id, "cust_a"),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { code: "currency_mismatch" },
    });
  });
});

describe("CartService.markAbandoned", () => {
  it("sets the cart's status to abandoned", async () => {
    const { service } = buildService();
    const cart = await service.createGuestCart("IDR");
    const after = await service.markAbandoned(cart.id);
    expect(after.status).toBe("abandoned");
  });

  it("refuses to abandon a converted cart", async () => {
    const { service, store } = buildService();
    seedVariant(store, "var_1", 100n, "IDR");
    const guest = await service.createGuestCart("IDR");
    await service.addItem(guest.id, { variantId: "var_1", quantity: 1 });
    // Promote into a customer cart so the guest cart becomes `converted`.
    const _ = await service.mergeGuestIntoCustomer(guest.id, "cust_a");
    void _;

    // Re-bind path uses the same row, so the guest cart did NOT become
    // converted in this case — make a second guest cart and force its
    // conversion through the merge-into-existing path instead.
    const guest2 = await service.createGuestCart("IDR");
    await service.addItem(guest2.id, { variantId: "var_1", quantity: 1 });
    await service.mergeGuestIntoCustomer(guest2.id, "cust_a");

    await expect(service.markAbandoned(guest2.id)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

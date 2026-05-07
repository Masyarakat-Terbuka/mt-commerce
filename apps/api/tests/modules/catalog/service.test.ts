/**
 * Catalog service — unit tests against an in-memory fake repository.
 *
 * The service is constructed with a `CatalogRepository`; in production that
 * comes from `createCatalogRepository(db)`, but for tests we inject a hand-
 * rolled fake. This is cleaner than stubbing Drizzle's chained query API
 * and lets us assert business rules (currency precedence, soft deletes,
 * pagination math, atomic inventory) without a database.
 *
 * For route-level tests that exercise the wired-up singleton, see
 * `routes.test.ts` — those use `__setDbForTesting()` because they go
 * through the singleton path that the `index.ts` registers.
 */
import { describe, expect, it } from "vitest";
import { CatalogServiceImpl } from "../../../src/modules/catalog/service.js";
import { DEFAULT_LOCALE } from "../../../src/modules/catalog/i18n.js";
import type {
  CategoryRow,
  InventoryLevelRow,
  NewCategoryRow,
  NewInventoryLevelRow,
  NewProductRow,
  NewProductVariantRow,
  ProductRow,
  ProductVariantRow,
} from "../../../src/db/schema/index.js";
import type { CatalogRepository } from "../../../src/modules/catalog/repository.js";

// ---------------------------------------------------------------------------
// In-memory repository
// ---------------------------------------------------------------------------

interface FakeStore {
  products: Map<string, ProductRow>;
  variants: Map<string, ProductVariantRow>;
  categories: Map<string, CategoryRow>;
  productCategories: Map<string, Set<string>>; // productId -> categoryIds
  inventory: Map<string, InventoryLevelRow>; // by inventory level id
}

function createFakeStore(): FakeStore {
  return {
    products: new Map(),
    variants: new Map(),
    categories: new Map(),
    productCategories: new Map(),
    inventory: new Map(),
  };
}

function createFakeRepository(store: FakeStore): CatalogRepository {
  const now = (): Date => new Date("2026-05-07T12:00:00.000Z");
  return {
    async insertProduct(row: NewProductRow): Promise<ProductRow> {
      const product: ProductRow = {
        id: row.id,
        slug: row.slug,
        translations: row.translations ?? {},
        status: row.status ?? "draft",
        defaultCurrency: row.defaultCurrency,
        imageUrl: row.imageUrl ?? null,
        imageAlt: row.imageAlt ?? null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      };
      store.products.set(product.id, product);
      return product;
    },
    async getProductById(id) {
      return store.products.get(id) ?? null;
    },
    async getProductBySlug(slug) {
      for (const p of store.products.values()) if (p.slug === slug) return p;
      return null;
    },
    async listProducts(filters) {
      let rows = [...store.products.values()];
      if (filters.excludeDeleted) {
        rows = rows.filter((p) => p.deletedAt === null);
      }
      if (filters.status) {
        rows = rows.filter((p) => p.status === filters.status);
      }
      if (filters.search) {
        // Faithful in-memory port of repository.escapeLikePattern + the
        // JSONB-aware ILIKE: a `%` or `_` in the *search term* matches itself
        // only. The real repository pulls the title from
        // `translations -> '<locale>' ->> 'title'`; we mirror that here so
        // the fake honors the locale filter.
        const needle = filters.search.toLowerCase();
        const locale = filters.locale ?? DEFAULT_LOCALE;
        rows = rows.filter((p) => {
          const title =
            p.translations[locale]?.title ??
            p.translations[DEFAULT_LOCALE]?.title ??
            "";
          return title.toLowerCase().includes(needle);
        });
      }
      if (filters.categoryId) {
        rows = rows.filter((p) =>
          store.productCategories.get(p.id)?.has(filters.categoryId!),
        );
      }
      // Price filtering must respect the same status/soft-delete restrictions
      // as the outer products query (per the EXISTS the real repo emits).
      const visibleVariantsForProduct = (productId: string) => {
        const product = store.products.get(productId);
        if (!product) return [];
        if (filters.excludeDeleted && product.deletedAt !== null) return [];
        if (filters.status && product.status !== filters.status) return [];
        return [...store.variants.values()].filter(
          (v) => v.productId === productId && v.deletedAt === null,
        );
      };
      if (filters.minPriceAmount !== undefined) {
        const min = filters.minPriceAmount;
        rows = rows.filter((p) =>
          visibleVariantsForProduct(p.id).some((v) => v.priceAmount >= min),
        );
      }
      if (filters.maxPriceAmount !== undefined) {
        const max = filters.maxPriceAmount;
        rows = rows.filter((p) =>
          visibleVariantsForProduct(p.id).some((v) => v.priceAmount <= max),
        );
      }
      // Sort. Default is "newest" by createdAt desc; price sorts use the
      // cheapest non-deleted variant per product (matches the correlated
      // subquery in the real repository).
      const cheapest = (productId: string): bigint | null => {
        const variants = [...store.variants.values()].filter(
          (v) => v.productId === productId && v.deletedAt === null,
        );
        if (variants.length === 0) return null;
        return variants.reduce(
          (min, v) => (v.priceAmount < min ? v.priceAmount : min),
          variants[0]!.priceAmount,
        );
      };
      switch (filters.sort) {
        case "oldest":
          rows = rows.slice().sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
          break;
        case "price_asc":
        case "price_desc": {
          const dir = filters.sort === "price_asc" ? 1 : -1;
          rows = rows.slice().sort((a, b) => {
            const ca = cheapest(a.id);
            const cb = cheapest(b.id);
            // NULLS LAST behavior: products with no variant sort to the end.
            if (ca === null && cb === null) return 0;
            if (ca === null) return 1;
            if (cb === null) return -1;
            if (ca === cb) return 0;
            return ca < cb ? -dir : dir;
          });
          break;
        }
        case "newest":
        default:
          rows = rows.slice().sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
          break;
      }
      const total = rows.length;
      const start = (filters.page - 1) * filters.pageSize;
      const page = rows.slice(start, start + filters.pageSize);
      return { rows: page, total };
    },
    async updateProduct(id, patch) {
      const existing = store.products.get(id);
      if (!existing) return null;
      const updated: ProductRow = {
        ...existing,
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.translations !== undefined
          ? { translations: patch.translations }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.defaultCurrency !== undefined ? { defaultCurrency: patch.defaultCurrency } : {}),
        updatedAt: now(),
      };
      store.products.set(id, updated);
      return updated;
    },
    async softDeleteProduct(id) {
      const existing = store.products.get(id);
      if (!existing) return;
      store.products.set(id, { ...existing, deletedAt: now() });
    },
    async insertVariant(row: NewProductVariantRow) {
      const v: ProductVariantRow = {
        id: row.id,
        productId: row.productId,
        sku: row.sku,
        translations: row.translations ?? {},
        priceAmount: row.priceAmount,
        priceCurrency: row.priceCurrency,
        compareAtAmount: row.compareAtAmount ?? null,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
      };
      store.variants.set(v.id, v);
      return v;
    },
    async getVariantById(id) {
      return store.variants.get(id) ?? null;
    },
    async listVariantsForProducts(productIds) {
      const set = new Set(productIds);
      return [...store.variants.values()].filter(
        (v) => set.has(v.productId) && v.deletedAt === null,
      );
    },
    async updateVariant(id, patch) {
      const existing = store.variants.get(id);
      if (!existing) return null;
      const updated: ProductVariantRow = {
        ...existing,
        ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
        ...(patch.translations !== undefined
          ? { translations: patch.translations }
          : {}),
        ...(patch.priceAmount !== undefined ? { priceAmount: patch.priceAmount } : {}),
        ...(patch.priceCurrency !== undefined ? { priceCurrency: patch.priceCurrency } : {}),
        ...(patch.compareAtAmount !== undefined ? { compareAtAmount: patch.compareAtAmount } : {}),
        updatedAt: now(),
      };
      store.variants.set(id, updated);
      return updated;
    },
    async softDeleteVariant(id) {
      const existing = store.variants.get(id);
      if (!existing) return;
      store.variants.set(id, { ...existing, deletedAt: now() });
    },
    async insertCategory(row: NewCategoryRow) {
      const c: CategoryRow = {
        id: row.id,
        slug: row.slug,
        translations: row.translations ?? {},
        parentId: row.parentId ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      store.categories.set(c.id, c);
      return c;
    },
    async getCategoryById(id) {
      return store.categories.get(id) ?? null;
    },
    async listCategories() {
      return [...store.categories.values()];
    },
    async updateCategory(id, patch) {
      const existing = store.categories.get(id);
      if (!existing) return null;
      const updated: CategoryRow = {
        ...existing,
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.translations !== undefined
          ? { translations: patch.translations }
          : {}),
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
        updatedAt: now(),
      };
      store.categories.set(id, updated);
      return updated;
    },
    async deleteCategory(id) {
      store.categories.delete(id);
    },
    async setProductCategories(productId, categoryIds) {
      store.productCategories.set(productId, new Set(categoryIds));
    },
    async listCategoryIdsForProducts(productIds) {
      const result = new Map<string, string[]>();
      for (const pid of productIds) {
        const set = store.productCategories.get(pid);
        if (set) result.set(pid, [...set]);
      }
      return result;
    },
    async insertInventoryLevel(row: NewInventoryLevelRow) {
      const inv: InventoryLevelRow = {
        id: row.id,
        variantId: row.variantId,
        locationId: row.locationId ?? null,
        available: row.available ?? 0,
        reserved: row.reserved ?? 0,
        updatedAt: now(),
      };
      store.inventory.set(inv.id, inv);
      return inv;
    },
    async getInventoryByVariant(variantId) {
      for (const inv of store.inventory.values()) {
        if (inv.variantId === variantId && inv.locationId === null) return inv;
      }
      return null;
    },
    async adjustInventoryAtomic(variantId, delta) {
      for (const [id, inv] of store.inventory) {
        if (inv.variantId === variantId && inv.locationId === null) {
          const next = inv.available + delta;
          if (next < 0) return null;
          const updated: InventoryLevelRow = {
            ...inv,
            available: next,
            updatedAt: now(),
          };
          store.inventory.set(id, updated);
          return updated;
        }
      }
      return null;
    },
  };
}

function buildService(): {
  service: CatalogServiceImpl;
  store: FakeStore;
} {
  const store = createFakeStore();
  const repo = createFakeRepository(store);
  return { service: new CatalogServiceImpl(repo), store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CatalogService.createProduct", () => {
  it("returns a Product with Money price after a variant is added", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "kemeja-batik",
      translations: { id: { title: "Kemeja Batik" } },
      defaultCurrency: "IDR",
    });
    expect(product.id).toMatch(/^prod_/);
    expect(product.slug).toBe("kemeja-batik");
    expect(product.defaultCurrency).toBe("IDR");

    const variant = await service.createVariant(product.id, {
      sku: "KMJ-BTK-001",
      priceAmount: 250_000n,
    });
    expect(variant.price).toEqual({ amount: 250_000n, currency: "IDR" });
    expect(variant.compareAtPrice).toBeNull();
  });

  it("rejects a duplicate slug with ConflictError", async () => {
    const { service } = buildService();
    await service.createProduct({
      slug: "duplicate",
      translations: { id: { title: "First" } },
      defaultCurrency: "IDR",
    });
    await expect(
      service.createProduct({
        slug: "duplicate",
        translations: { id: { title: "Second" } },
        defaultCurrency: "IDR",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("CatalogService.listProducts pagination", () => {
  it("returns the requested slice and the unfiltered total", async () => {
    const { service } = buildService();
    for (let i = 0; i < 25; i++) {
      await service.createProduct({
        slug: `p-${i.toString().padStart(2, "0")}`,
        translations: { id: { title: `Product ${i}` } },
        status: "active",
        defaultCurrency: "IDR",
      });
    }
    const page1 = await service.listProducts({
      page: 1,
      pageSize: 10,
      sort: "newest",
    });
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(10);
    expect(page1.data).toHaveLength(10);

    const page3 = await service.listProducts({
      page: 3,
      pageSize: 10,
      sort: "newest",
    });
    expect(page3.data).toHaveLength(5);
  });

  it("clamps pageSize to MAX_PAGE_SIZE", async () => {
    const { service } = buildService();
    const result = await service.listProducts({
      page: 1,
      // The Zod schema enforces this at the boundary, but the service must
      // also be safe on its own — defense in depth for non-HTTP callers.
      pageSize: 9999,
      sort: "newest",
    });
    expect(result.pageSize).toBeLessThanOrEqual(100);
  });
});

describe("CatalogService.softDeleteProduct", () => {
  it("sets deletedAt and hides the product from active-only reads", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "soft-target",
      translations: { id: { title: "Soft target" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    await service.softDeleteProduct(product.id);
    const direct = await service.getProductById(product.id);
    expect(direct?.deletedAt).toBeInstanceOf(Date);

    const stripped = await service.getProductBySlug("soft-target", {
      activeOnly: true,
    });
    expect(stripped).toBeNull();
  });
});

describe("CatalogService.getProductBySlug activeOnly", () => {
  it("returns null for archived products in storefront context", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "old-listing",
      translations: { id: { title: "Old listing" } },
      status: "archived",
      defaultCurrency: "IDR",
    });
    const admin = await service.getProductBySlug("old-listing");
    expect(admin?.id).toBe(product.id);

    const storefront = await service.getProductBySlug("old-listing", {
      activeOnly: true,
    });
    expect(storefront).toBeNull();
  });
});

describe("CatalogService.adjustInventory", () => {
  async function setup() {
    const { service, store } = buildService();
    const product = await service.createProduct({
      slug: "inv-test",
      translations: { id: { title: "Inv test" } },
      defaultCurrency: "IDR",
    });
    const variant = await service.createVariant(product.id, {
      sku: "INV-001",
      priceAmount: 1_000n,
    });
    return { service, store, variantId: variant.id };
  }

  it("increments available", async () => {
    const { service, variantId } = await setup();
    const after = await service.adjustInventory(variantId, 7);
    expect(after.available).toBe(7);
  });

  it("decrements when there is stock", async () => {
    const { service, variantId } = await setup();
    await service.adjustInventory(variantId, 10);
    const after = await service.adjustInventory(variantId, -3);
    expect(after.available).toBe(7);
  });

  it("rejects when the result would be negative", async () => {
    const { service, variantId } = await setup();
    await service.adjustInventory(variantId, 2);
    await expect(service.adjustInventory(variantId, -5)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects a delta of zero", async () => {
    const { service, variantId } = await setup();
    await expect(service.adjustInventory(variantId, 0)).rejects.toMatchObject({
      code: "validation_error",
    });
  });
});

describe("CatalogService.createVariant currency rule", () => {
  it("uses the product default when priceCurrency is omitted", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "default-currency",
      translations: { id: { title: "Default" } },
      defaultCurrency: "IDR",
    });
    const variant = await service.createVariant(product.id, {
      sku: "DEF-001",
      priceAmount: 100n,
    });
    expect(variant.price.currency).toBe("IDR");
  });

  it("rejects mismatched explicit currency", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "mismatch",
      translations: { id: { title: "Mismatch" } },
      defaultCurrency: "IDR",
    });
    await expect(
      service.createVariant(product.id, {
        sku: "MM-001",
        priceAmount: 100n,
        priceCurrency: "USD",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});

// ---------------------------------------------------------------------------
// QA fixes — regression tests
// ---------------------------------------------------------------------------

describe("CatalogService.listProducts price filter visibility", () => {
  it("does not surface variants of archived products via a price filter", async () => {
    const { service } = buildService();
    // Active product with a variant in the band.
    const visible = await service.createProduct({
      slug: "visible-prod",
      translations: { id: { title: "Visible product" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    await service.createVariant(visible.id, {
      sku: "VIS-001",
      priceAmount: 5_000n,
    });
    // Archived product — must NOT appear in storefront price-band results,
    // even though its variant matches the filter.
    const hidden = await service.createProduct({
      slug: "archived-prod",
      translations: { id: { title: "Archived product" } },
      status: "archived",
      defaultCurrency: "IDR",
    });
    await service.createVariant(hidden.id, {
      sku: "HID-001",
      priceAmount: 5_000n,
    });

    const result = await service.listProducts({
      page: 1,
      pageSize: 20,
      sort: "newest",
      activeOnly: true,
      minPriceAmount: 1_000n,
      maxPriceAmount: 10_000n,
    });
    const ids = result.data.map((p) => p.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id);
  });
});

describe("CatalogService.listProducts price sort", () => {
  async function seedThree() {
    const { service } = buildService();
    const a = await service.createProduct({
      slug: "p-a",
      translations: { id: { title: "A" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    await service.createVariant(a.id, { sku: "A-1", priceAmount: 100n });
    const b = await service.createProduct({
      slug: "p-b",
      translations: { id: { title: "B" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    await service.createVariant(b.id, { sku: "B-1", priceAmount: 50n });
    const c = await service.createProduct({
      slug: "p-c",
      translations: { id: { title: "C" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    await service.createVariant(c.id, { sku: "C-1", priceAmount: 200n });
    return { service, ids: { a: a.id, b: b.id, c: c.id } };
  }

  it("price_asc orders products by cheapest variant ascending", async () => {
    const { service, ids } = await seedThree();
    const result = await service.listProducts({
      page: 1,
      pageSize: 20,
      sort: "price_asc",
      activeOnly: true,
    });
    expect(result.data.map((p) => p.id)).toEqual([ids.b, ids.a, ids.c]);
  });

  it("price_desc orders products by cheapest variant descending", async () => {
    const { service, ids } = await seedThree();
    const result = await service.listProducts({
      page: 1,
      pageSize: 20,
      sort: "price_desc",
      activeOnly: true,
    });
    expect(result.data.map((p) => p.id)).toEqual([ids.c, ids.a, ids.b]);
  });
});

describe("CatalogService.updateProduct currency consistency", () => {
  it("rejects defaultCurrency change when a variant prices in another currency", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "ccy-mismatch",
      translations: { id: { title: "Currency mismatch" } },
      defaultCurrency: "IDR",
    });
    await service.createVariant(product.id, {
      sku: "CCY-001",
      priceAmount: 100n,
    });
    await expect(
      service.updateProduct(product.id, { defaultCurrency: "USD" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { code: "currency_mismatch" },
    });
  });

  it("allows defaultCurrency change when there are no variants yet", async () => {
    const { service } = buildService();
    const product = await service.createProduct({
      slug: "ccy-empty",
      translations: { id: { title: "No variants" } },
      defaultCurrency: "IDR",
    });
    const updated = await service.updateProduct(product.id, {
      defaultCurrency: "USD",
    });
    expect(updated.defaultCurrency).toBe("USD");
  });
});

describe("CatalogService.listProducts search escaping", () => {
  it("treats `%` and `_` in the search term as literals, not wildcards", async () => {
    const { service } = buildService();
    const a = await service.createProduct({
      slug: "coffee-100",
      translations: { id: { title: "Coffee 100% Arabica" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    const b = await service.createProduct({
      slug: "coffee-robusta",
      translations: { id: { title: "Coffee Robusta" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    const c = await service.createProduct({
      slug: "tea",
      translations: { id: { title: "Tea Beverage" } },
      status: "active",
      defaultCurrency: "IDR",
    });
    void b;
    void c;

    const result = await service.listProducts({
      page: 1,
      pageSize: 20,
      sort: "newest",
      activeOnly: true,
      search: "100%",
    });
    const ids = result.data.map((p) => p.id);
    expect(ids).toEqual([a.id]);
  });
});

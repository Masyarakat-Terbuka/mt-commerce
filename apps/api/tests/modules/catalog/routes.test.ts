/**
 * Catalog routes — smoke tests over Hono's `app.request()`. The router is
 * built with a fake `CatalogService` (the public injection point on
 * `buildCatalogAdminRoutes`/`buildCatalogStorefrontRoutes`), keeping the
 * test focused on:
 *
 *   1. The standard JSON envelope (success + error)
 *   2. Money serialization per ADR-0007 (string amount, ISO 4217 currency)
 *   3. Pagination shape `{ data, total, page, pageSize }`
 *   4. Storefront active-only filter rejecting drafts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildCatalogAdminRoutes } from "../../../src/modules/catalog/routes/admin.js";
import { buildCatalogStorefrontRoutes } from "../../../src/modules/catalog/routes/storefront.js";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { installBigIntJsonSerializer } from "../../../src/lib/json.js";
import { authService } from "../../../src/modules/auth/index.js";
import type {
  Category,
  CatalogService,
  InventoryLevel,
  Paginated,
  Product,
  Variant,
} from "../../../src/modules/catalog/index.js";
import type { AppBindings } from "../../../src/lib/types.js";

// Ensure the global BigInt serializer is installed exactly once for these
// tests; in production `app.ts` does this on first call.
installBigIntJsonSerializer();

// The catalog admin routes are gated by requireAuth + requireRole from the
// auth module. These tests focus on catalog wire/validation behavior, not
// auth — so we stub the auth singleton's verifier and staff lookup to
// always succeed for a synthetic bearer. Each request that wants to be
// authenticated sends `Authorization: Bearer test-staff` and gets through
// as a staff user named `usr_test`.
const STAFF_BEARER = "Bearer test-staff";
const TEST_NOW = new Date("2026-05-07T12:00:00.000Z");
const STAFF_USER = {
  id: "usr_test",
  email: "test@example.com",
  emailVerified: true,
  name: "Test",
  image: null,
  createdAt: TEST_NOW,
  updatedAt: TEST_NOW,
};

beforeEach(() => {
  vi.spyOn(authService, "verifyApiKey").mockImplementation(async (bearer) => {
    if (bearer !== "test-staff") return null;
    return {
      apiKey: {
        id: "apik_test",
        userId: STAFF_USER.id,
        name: "test",
        scopes: ["catalog:read", "catalog:write"],
        lastUsedAt: null,
        createdAt: TEST_NOW,
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
      displayName: "Test",
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    };
  });
});

/** Convenience: attach the test bearer to a request init. */
function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", STAFF_BEARER);
  return { ...init, headers };
}

const fixedDate = new Date("2026-05-07T12:00:00.000Z");

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: overrides.id ?? "prod_test",
    slug: overrides.slug ?? "test",
    title: overrides.title ?? "Test Product",
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    defaultCurrency: overrides.defaultCurrency ?? "IDR",
    imageUrl: overrides.imageUrl ?? null,
    imageAlt: overrides.imageAlt ?? null,
    categoryIds: overrides.categoryIds ?? [],
    variants: overrides.variants ?? [makeVariant()],
    createdAt: overrides.createdAt ?? fixedDate,
    updatedAt: overrides.updatedAt ?? fixedDate,
    deletedAt: overrides.deletedAt ?? null,
  };
}

function makeVariant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: overrides.id ?? "var_test",
    productId: overrides.productId ?? "prod_test",
    sku: overrides.sku ?? "SKU-1",
    title: overrides.title ?? null,
    price: overrides.price ?? { amount: 250_000n, currency: "IDR" },
    compareAtPrice: overrides.compareAtPrice ?? null,
    createdAt: overrides.createdAt ?? fixedDate,
    updatedAt: overrides.updatedAt ?? fixedDate,
    deletedAt: overrides.deletedAt ?? null,
  };
}

interface FakeServiceState {
  productsBySlug: Map<string, Product>;
  productsById: Map<string, Product>;
}

function createFakeService(state: FakeServiceState): CatalogService {
  const fail = (): never => {
    throw new Error("not implemented in smoke test");
  };
  return {
    async createProduct(): Promise<Product> {
      return fail();
    },
    async getProductById(id) {
      return state.productsById.get(id) ?? null;
    },
    async getProductBySlug(slug, options) {
      const found = state.productsBySlug.get(slug) ?? null;
      if (!found) return null;
      if (options?.activeOnly) {
        if (found.status !== "active" || found.deletedAt !== null) return null;
      }
      return found;
    },
    async listProducts(query): Promise<Paginated<Product>> {
      let items = [...state.productsById.values()];
      if (query.activeOnly) {
        items = items.filter(
          (p) => p.status === "active" && p.deletedAt === null,
        );
      }
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 20;
      const start = (page - 1) * pageSize;
      return {
        data: items.slice(start, start + pageSize),
        total: items.length,
        page,
        pageSize,
      };
    },
    async updateProduct(): Promise<Product> {
      return fail();
    },
    async softDeleteProduct(): Promise<void> {
      return;
    },
    async createVariant(): Promise<Variant> {
      return fail();
    },
    async updateVariant(): Promise<Variant> {
      return fail();
    },
    async softDeleteVariant(): Promise<void> {
      return;
    },
    async listCategories(): Promise<Category[]> {
      return [];
    },
    async createCategory(): Promise<Category> {
      return fail();
    },
    async updateCategory(): Promise<Category> {
      return fail();
    },
    async deleteCategory(): Promise<void> {
      return;
    },
    async getInventory(): Promise<InventoryLevel | null> {
      return null;
    },
    async adjustInventory(): Promise<InventoryLevel> {
      return fail();
    },
  };
}

function buildAdminApp(service: CatalogService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildCatalogAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(service: CatalogService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/storefront/v1", buildCatalogStorefrontRoutes(service));
  app.onError(errorHandler);
  return app;
}

describe("admin routes /admin/v1/products", () => {
  it("serializes Money as a string amount + currency", async () => {
    const product = makeProduct({
      slug: "kemeja-batik",
      variants: [
        makeVariant({
          price: { amount: 1_500_000n, currency: "IDR" },
          compareAtPrice: { amount: 2_000_000n, currency: "IDR" },
        }),
      ],
    });
    const state: FakeServiceState = {
      productsBySlug: new Map([[product.slug, product]]),
      productsById: new Map([[product.id, product]]),
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request("/admin/v1/products/prod_test", withAuth());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      variants: Array<{
        price: { amount: string; currency: string };
        compareAtPrice: { amount: string; currency: string } | null;
      }>;
    };
    expect(body.variants[0]?.price).toEqual({
      amount: "1500000",
      currency: "IDR",
    });
    expect(body.variants[0]?.compareAtPrice).toEqual({
      amount: "2000000",
      currency: "IDR",
    });
  });

  it("returns the standard error envelope for not-found", async () => {
    const state: FakeServiceState = {
      productsBySlug: new Map(),
      productsById: new Map(),
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request("/admin/v1/products/prod_missing", withAuth());
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects an oversized inventory `delta` with 400 (not 500)", async () => {
    // A delta past the configured bound must be caught at the Zod boundary
    // and surface as a validation_error — never an unhandled DB int4 overflow.
    const state: FakeServiceState = {
      productsBySlug: new Map(),
      productsById: new Map(),
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request(
      "/admin/v1/variants/var_xyz/inventory/adjust",
      withAuth({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: 9_999_999 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects unknown ISO 4217 currency on product create", async () => {
    // `defaultCurrency: "XXX"` matches the regex but is not in
    // KNOWN_CURRENCIES — must surface as 400 validation_error, not 500.
    const state: FakeServiceState = {
      productsBySlug: new Map(),
      productsById: new Map(),
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request(
      "/admin/v1/products",
      withAuth({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "unknown-currency",
          translations: { id: { title: "Unknown Currency" } },
          defaultCurrency: "XXX",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects a list query that supplies both categoryId and categorySlug", async () => {
    // The schema's refine() should kick in and prevent ambiguity.
    const state: FakeServiceState = {
      productsBySlug: new Map(),
      productsById: new Map(),
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request(
      "/admin/v1/products?categoryId=cat_1&categorySlug=foo",
      withAuth(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
  });

  it("paginates the list response with { data, total, page, pageSize }", async () => {
    const products = new Map<string, Product>();
    for (let i = 0; i < 25; i++) {
      const p = makeProduct({ id: `prod_${i}`, slug: `p-${i}` });
      products.set(p.id, p);
    }
    const state: FakeServiceState = {
      productsBySlug: new Map(),
      productsById: products,
    };
    const app = buildAdminApp(createFakeService(state));
    const res = await app.request(
      "/admin/v1/products?page=2&pageSize=10",
      withAuth(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(25);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(10);
    expect(body.data).toHaveLength(10);
  });
});

describe("storefront routes /storefront/v1/products/:slug", () => {
  it("hides drafts from storefront callers", async () => {
    const draft = makeProduct({ slug: "draft-only", status: "draft" });
    const state: FakeServiceState = {
      productsBySlug: new Map([[draft.slug, draft]]),
      productsById: new Map([[draft.id, draft]]),
    };
    const app = buildStorefrontApp(createFakeService(state));
    const res = await app.request("/storefront/v1/products/draft-only");
    expect(res.status).toBe(404);
  });

  it("strips `?status=archived` and forces active-only when listing", async () => {
    // Storefront callers must not be able to bypass the active-only filter
    // by passing `status` on the query string. The route should drop the
    // status field before delegating to the service. We assert two things:
    //   (a) the response is 200 with active-only products,
    //   (b) the service receives no `status` value (so it cannot leak
    //       archived/draft listings even if the service had a bug).
    const active = makeProduct({
      id: "prod_active",
      slug: "active-1",
      status: "active",
    });
    const archived = makeProduct({
      id: "prod_archived",
      slug: "archived-1",
      status: "archived",
    });
    const state: FakeServiceState = {
      productsBySlug: new Map([
        [active.slug, active],
        [archived.slug, archived],
      ]),
      productsById: new Map([
        [active.id, active],
        [archived.id, archived],
      ]),
    };
    const observed: Array<{ status?: string; activeOnly?: boolean }> = [];
    const baseService = createFakeService(state);
    const spyService: CatalogService = {
      ...baseService,
      async listProducts(query) {
        observed.push({
          status: query.status,
          activeOnly: query.activeOnly,
        });
        return baseService.listProducts(query);
      },
    };
    const app = buildStorefrontApp(spyService);
    const res = await app.request(
      "/storefront/v1/products?status=archived",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((p) => p.id)).toEqual(["prod_active"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.status).toBeUndefined();
    expect(observed[0]?.activeOnly).toBe(true);
  });

  it("returns active products with Money serialized as MoneyJSON", async () => {
    const product = makeProduct({ slug: "active-listing" });
    const state: FakeServiceState = {
      productsBySlug: new Map([[product.slug, product]]),
      productsById: new Map([[product.id, product]]),
    };
    const app = buildStorefrontApp(createFakeService(state));
    const res = await app.request("/storefront/v1/products/active-listing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      variants: Array<{ price: { amount: string; currency: string } }>;
    };
    expect(body.slug).toBe("active-listing");
    expect(body.variants[0]?.price.currency).toBe("IDR");
    expect(body.variants[0]?.price.amount).toMatch(/^\d+$/);
  });
});

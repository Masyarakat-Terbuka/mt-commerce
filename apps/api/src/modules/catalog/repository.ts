/**
 * Catalog repository — Drizzle queries, no domain logic.
 *
 * The repository returns Drizzle row types; the service composes those into
 * domain objects via `mappers.ts`. Keeping the boundary at this layer means:
 *
 *   - Tests can stub the repository without standing up a database.
 *   - The service is free to combine multiple repository calls without a
 *     query layer leaking into business logic.
 *   - Cross-module callers never see Drizzle types — only the domain types
 *     from `index.ts`.
 *
 * Every method accepts an optional `tx` so callers can run multi-statement
 * work in a single transaction. The default uses the module-level `db`.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  categories,
  inventoryLevels,
  productCategories,
  productVariants,
  products,
  type CategoryRow,
  type InventoryLevelRow,
  type NewCategoryRow,
  type NewInventoryLevelRow,
  type NewProductRow,
  type NewProductVariantRow,
  type ProductRow,
  type ProductVariantRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { ProductSort, ProductStatus } from "./types.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface ProductListFilters {
  status?: ProductStatus;
  /** When set, only products with `deleted_at` IS NULL are returned. */
  excludeDeleted?: boolean;
  categoryId?: string;
  categorySlug?: string;
  search?: string;
  minPriceAmount?: bigint;
  maxPriceAmount?: bigint;
  page: number;
  pageSize: number;
  sort: ProductSort;
}

export interface ProductListResult {
  rows: ProductRow[];
  total: number;
}

/**
 * Encapsulate the Drizzle calls so route/service code stays high-level. The
 * returned object is a singleton per `db`. Callers needing a transaction call
 * `db.transaction(async (tx) => createRepository(tx).createProduct(...))`.
 */
export function createCatalogRepository(db: Db = defaultDb) {
  return {
    // -------------------------------------------------------------------
    // Products
    // -------------------------------------------------------------------
    async insertProduct(row: NewProductRow): Promise<ProductRow> {
      const [inserted] = await db.insert(products).values(row).returning();
      if (!inserted) throw new Error("insertProduct: returning() yielded no rows");
      return inserted;
    },

    async getProductById(id: string): Promise<ProductRow | null> {
      const [row] = await db
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      return row ?? null;
    },

    async getProductBySlug(slug: string): Promise<ProductRow | null> {
      const [row] = await db
        .select()
        .from(products)
        .where(eq(products.slug, slug))
        .limit(1);
      return row ?? null;
    },

    /**
     * List products with filters, search, and offset pagination. The total
     * count is computed in a separate aggregate so we can paginate cleanly;
     * a window-function approach would also work but adds a per-row cost
     * that does not pay for itself at v0.1 scale.
     *
     * Price filtering joins the variants table — we filter by the cheapest
     * variant's amount, which matches the storefront's "from Rp X" semantics.
     */
    async listProducts(filters: ProductListFilters): Promise<ProductListResult> {
      const conditions = [] as ReturnType<typeof eq>[];
      if (filters.excludeDeleted) {
        conditions.push(isNull(products.deletedAt));
      }
      if (filters.status) {
        conditions.push(eq(products.status, filters.status));
      }
      if (filters.search) {
        // ILIKE on title is sufficient for v0.1; full-text search lands later.
        conditions.push(ilike(products.title, `%${filters.search}%`));
      }
      if (filters.categoryId) {
        const productIds = db
          .select({ pid: productCategories.productId })
          .from(productCategories)
          .where(eq(productCategories.categoryId, filters.categoryId));
        conditions.push(inArray(products.id, productIds));
      }
      if (filters.categorySlug) {
        const productIds = db
          .select({ pid: productCategories.productId })
          .from(productCategories)
          .innerJoin(categories, eq(productCategories.categoryId, categories.id))
          .where(eq(categories.slug, filters.categorySlug));
        conditions.push(inArray(products.id, productIds));
      }
      if (filters.minPriceAmount !== undefined) {
        const minVariants = db
          .select({ pid: productVariants.productId })
          .from(productVariants)
          .where(
            and(
              isNull(productVariants.deletedAt),
              gte(productVariants.priceAmount, filters.minPriceAmount),
            ),
          );
        conditions.push(inArray(products.id, minVariants));
      }
      if (filters.maxPriceAmount !== undefined) {
        const maxVariants = db
          .select({ pid: productVariants.productId })
          .from(productVariants)
          .where(
            and(
              isNull(productVariants.deletedAt),
              lte(productVariants.priceAmount, filters.maxPriceAmount),
            ),
          );
        conditions.push(inArray(products.id, maxVariants));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const orderBy = (() => {
        switch (filters.sort) {
          case "oldest":
            return asc(products.createdAt);
          case "price_asc":
          case "price_desc":
            // Price-based sort needs the variants table. Do it in a follow-up
            // if/when storefront demands it — for v0.1 we degrade to "newest"
            // so the response is still useful.
            return desc(products.createdAt);
          case "newest":
          default:
            return desc(products.createdAt);
        }
      })();

      const rows = await db
        .select()
        .from(products)
        .where(where ?? sql`true`)
        .orderBy(orderBy)
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async updateProduct(
      id: string,
      patch: Partial<NewProductRow>,
    ): Promise<ProductRow | null> {
      const [updated] = await db
        .update(products)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(products.id, id))
        .returning();
      return updated ?? null;
    },

    async softDeleteProduct(id: string): Promise<void> {
      await db
        .update(products)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(products.id, id));
    },

    // -------------------------------------------------------------------
    // Variants
    // -------------------------------------------------------------------
    async insertVariant(row: NewProductVariantRow): Promise<ProductVariantRow> {
      const [inserted] = await db
        .insert(productVariants)
        .values(row)
        .returning();
      if (!inserted) throw new Error("insertVariant: returning() yielded no rows");
      return inserted;
    },

    async getVariantById(id: string): Promise<ProductVariantRow | null> {
      const [row] = await db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, id))
        .limit(1);
      return row ?? null;
    },

    async listVariantsForProducts(
      productIds: string[],
    ): Promise<ProductVariantRow[]> {
      if (productIds.length === 0) return [];
      return db
        .select()
        .from(productVariants)
        .where(
          and(
            inArray(productVariants.productId, productIds),
            isNull(productVariants.deletedAt),
          ),
        );
    },

    async updateVariant(
      id: string,
      patch: Partial<NewProductVariantRow>,
    ): Promise<ProductVariantRow | null> {
      const [updated] = await db
        .update(productVariants)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(productVariants.id, id))
        .returning();
      return updated ?? null;
    },

    async softDeleteVariant(id: string): Promise<void> {
      await db
        .update(productVariants)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(productVariants.id, id));
    },

    // -------------------------------------------------------------------
    // Categories
    // -------------------------------------------------------------------
    async insertCategory(row: NewCategoryRow): Promise<CategoryRow> {
      const [inserted] = await db.insert(categories).values(row).returning();
      if (!inserted) throw new Error("insertCategory: returning() yielded no rows");
      return inserted;
    },

    async getCategoryById(id: string): Promise<CategoryRow | null> {
      const [row] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      return row ?? null;
    },

    async listCategories(): Promise<CategoryRow[]> {
      return db.select().from(categories).orderBy(asc(categories.name));
    },

    async updateCategory(
      id: string,
      patch: Partial<NewCategoryRow>,
    ): Promise<CategoryRow | null> {
      const [updated] = await db
        .update(categories)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(categories.id, id))
        .returning();
      return updated ?? null;
    },

    async deleteCategory(id: string): Promise<void> {
      await db.delete(categories).where(eq(categories.id, id));
    },

    async setProductCategories(
      productId: string,
      categoryIds: string[],
    ): Promise<void> {
      await db
        .delete(productCategories)
        .where(eq(productCategories.productId, productId));
      if (categoryIds.length === 0) return;
      const rows = categoryIds.map((categoryId) => ({
        productId,
        categoryId,
      }));
      await db.insert(productCategories).values(rows);
    },

    async listCategoryIdsForProducts(
      productIds: string[],
    ): Promise<Map<string, string[]>> {
      const result = new Map<string, string[]>();
      if (productIds.length === 0) return result;
      const rows = await db
        .select()
        .from(productCategories)
        .where(inArray(productCategories.productId, productIds));
      for (const row of rows) {
        const existing = result.get(row.productId);
        if (existing) {
          existing.push(row.categoryId);
        } else {
          result.set(row.productId, [row.categoryId]);
        }
      }
      return result;
    },

    // -------------------------------------------------------------------
    // Inventory
    // -------------------------------------------------------------------
    async insertInventoryLevel(
      row: NewInventoryLevelRow,
    ): Promise<InventoryLevelRow> {
      const [inserted] = await db
        .insert(inventoryLevels)
        .values(row)
        .returning();
      if (!inserted) throw new Error("insertInventoryLevel: returning() yielded no rows");
      return inserted;
    },

    async getInventoryByVariant(
      variantId: string,
    ): Promise<InventoryLevelRow | null> {
      const [row] = await db
        .select()
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.variantId, variantId),
            isNull(inventoryLevels.locationId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Atomically apply `delta` to `available`, refusing to go below zero.
     * The `WHERE available + $1 >= 0` guard prevents over-decrement under
     * concurrent updates without a separate read-modify-write cycle.
     */
    async adjustInventoryAtomic(
      variantId: string,
      delta: number,
    ): Promise<InventoryLevelRow | null> {
      const [updated] = await db
        .update(inventoryLevels)
        .set({
          available: sql`${inventoryLevels.available} + ${delta}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryLevels.variantId, variantId),
            isNull(inventoryLevels.locationId),
            sql`${inventoryLevels.available} + ${delta} >= 0`,
          ),
        )
        .returning();
      return updated ?? null;
    },
  };
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;

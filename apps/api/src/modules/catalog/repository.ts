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
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
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
import {
  createAuditRepository,
  type AuditRepository,
} from "../audit/repository.js";
import type * as schema from "../../db/schema/index.js";
import { DEFAULT_LOCALE, type KnownLocale } from "./i18n.js";
import type { ProductSort, ProductStatus } from "./types.js";

/**
 * Escape characters that have special meaning to a Postgres `ILIKE` pattern.
 * Without escaping, a search term that legitimately contains `%` or `_` (e.g.
 * `"100%"`, `"foo_bar"`) silently turns into a wildcard. Backslash is escaped
 * first so we do not double-escape the escapes we add for `%` and `_`.
 */
export function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

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
  /**
   * Locale used for any translated-field predicate (search ILIKE on title).
   * Defaults to `DEFAULT_LOCALE` ("id"). The repository never resolves the
   * full translation blob — that's the mapper's job — but search must know
   * which locale's title to ILIKE against.
   */
  locale?: KnownLocale;
}

/**
 * Build a JSONB ->> expression for a translated text field. Postgres
 * `translations->>'<locale>'` returns the locale blob as text — but we want
 * a *field* inside that blob, so we chain `->` (JSON) then `->>` (text):
 *
 *     translations -> 'id' ->> 'title'
 *
 * The locale and field names are bound as parameters via the sql template,
 * not interpolated as raw SQL — so there is no injection surface even if
 * a future caller passes user input.
 */
function translatedField(
  column: import("drizzle-orm/pg-core").AnyPgColumn,
  locale: KnownLocale,
  field: string,
): SQL<string | null> {
  return sql<string | null>`${column} -> ${locale} ->> ${field}`;
}

export interface ProductListResult {
  rows: ProductRow[];
  total: number;
}

export interface InventoryListFilters {
  /** When set, only inventory rows whose variant belongs to this product. */
  productId?: string;
  page: number;
  pageSize: number;
}

export interface InventoryListResult {
  rows: InventoryLevelRow[];
  total: number;
}

/**
 * Catalog repository surface. Declared explicitly (rather than inferred from
 * `createCatalogRepository`) so `withTransaction` can name the recursive
 * shape it hands back without TypeScript chasing its tail through the
 * `ReturnType` of the factory.
 */
export interface CatalogRepository {
  // Products
  insertProduct(row: NewProductRow): Promise<ProductRow>;
  getProductById(id: string): Promise<ProductRow | null>;
  getProductBySlug(slug: string): Promise<ProductRow | null>;
  listProducts(filters: ProductListFilters): Promise<ProductListResult>;
  updateProduct(
    id: string,
    patch: Partial<NewProductRow>,
  ): Promise<ProductRow | null>;
  softDeleteProduct(id: string): Promise<void>;

  // Variants
  insertVariant(row: NewProductVariantRow): Promise<ProductVariantRow>;
  getVariantById(id: string): Promise<ProductVariantRow | null>;
  listVariantsForProducts(
    productIds: string[],
  ): Promise<ProductVariantRow[]>;
  updateVariant(
    id: string,
    patch: Partial<NewProductVariantRow>,
  ): Promise<ProductVariantRow | null>;
  softDeleteVariant(id: string): Promise<void>;

  // Categories
  insertCategory(row: NewCategoryRow): Promise<CategoryRow>;
  getCategoryById(id: string): Promise<CategoryRow | null>;
  listCategories(): Promise<CategoryRow[]>;
  updateCategory(
    id: string,
    patch: Partial<NewCategoryRow>,
  ): Promise<CategoryRow | null>;
  deleteCategory(id: string): Promise<void>;
  setProductCategories(
    productId: string,
    categoryIds: string[],
  ): Promise<void>;
  listCategoryIdsForProducts(
    productIds: string[],
  ): Promise<Map<string, string[]>>;

  // Inventory
  insertInventoryLevel(
    row: NewInventoryLevelRow,
  ): Promise<InventoryLevelRow>;
  getInventoryByVariant(
    variantId: string,
  ): Promise<InventoryLevelRow | null>;
  adjustInventoryAtomic(
    variantId: string,
    delta: number,
  ): Promise<InventoryLevelRow | null>;
  listInventoryLevels(
    filters: InventoryListFilters,
  ): Promise<InventoryListResult>;

  // Transactions
  withTransaction<T>(
    fn: (deps: {
      catalog: CatalogRepository;
      audit: AuditRepository;
    }) => Promise<T>,
  ): Promise<T>;
}

/**
 * Encapsulate the Drizzle calls so route/service code stays high-level. The
 * returned object is a singleton per `db`. Callers needing a transaction call
 * `db.transaction(async (tx) => createRepository(tx).createProduct(...))`.
 */
export function createCatalogRepository(db: Db = defaultDb): CatalogRepository {
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
      const conditions: SQL[] = [];
      if (filters.excludeDeleted) {
        conditions.push(isNull(products.deletedAt));
      }
      if (filters.status) {
        conditions.push(eq(products.status, filters.status));
      }
      if (filters.search) {
        // ILIKE on the resolved-locale title in the JSONB column. Per ADR-0010
        // we do not search across locales for v0.1 — the user is searching in
        // their viewing locale, which is what they see on screen.
        //
        // We escape `%`, `_`, and `\` so the user-supplied term cannot smuggle
        // wildcards into the pattern. The JSONB extraction uses parameters
        // for both the locale key and the field name (no string concat into
        // SQL), so even though the locale comes from a typed enum today, the
        // expression remains safe if a future caller passes user input.
        //
        // TODO (v0.2): a `tsvector` generated column or a partial GIN over
        // `translations` would let us search across locales without a per-row
        // table scan. Recorded in ADR-0010 ("Negative consequences").
        const safe = escapeLikePattern(filters.search);
        const locale = filters.locale ?? DEFAULT_LOCALE;
        conditions.push(
          sql`lower(${translatedField(products.translations, locale, "title")}) LIKE lower(${`%${safe}%`})`,
        );
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
      // Price filters MUST respect the same status/soft-delete restrictions as
      // the outer products query. We use a correlated EXISTS that joins
      // explicitly back to the `products` table and re-applies the same
      // visibility predicates. Defense in depth: even if the outer WHERE were
      // ever bypassed, the variant subquery alone cannot match a variant
      // belonging to a draft/archived/soft-deleted product.
      const buildPriceExists = (
        cmp: "min" | "max",
        amount: bigint,
      ): SQL => {
        const op = cmp === "min" ? sql`>=` : sql`<=`;
        const statusGuard = filters.status
          ? sql`AND p.status = ${filters.status}`
          : sql``;
        const deletedGuard = filters.excludeDeleted
          ? sql`AND p.deleted_at IS NULL`
          : sql``;
        return sql`EXISTS (
          SELECT 1 FROM ${productVariants} pv
          INNER JOIN ${products} p ON p.id = pv.product_id
          WHERE pv.product_id = ${products.id}
            AND pv.deleted_at IS NULL
            AND pv.price_amount ${op} ${amount}
            ${statusGuard}
            ${deletedGuard}
        )`;
      };
      if (filters.minPriceAmount !== undefined) {
        conditions.push(buildPriceExists("min", filters.minPriceAmount));
      }
      if (filters.maxPriceAmount !== undefined) {
        conditions.push(buildPriceExists("max", filters.maxPriceAmount));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      // Price sort uses a correlated subquery selecting the cheapest non-
      // deleted variant per product. Chosen over LATERAL JOIN for two
      // reasons: (a) Drizzle's type-safe ordering plays nicer with `sql`
      // fragments here, (b) the subquery is independent per row so the
      // planner can reuse the variant index on (product_id) without us
      // shaping the FROM clause.
      const orderBy = (() => {
        switch (filters.sort) {
          case "oldest":
            return asc(products.createdAt);
          case "price_asc":
            return sql`(
              SELECT min(pv.price_amount) FROM ${productVariants} pv
              WHERE pv.product_id = ${products.id} AND pv.deleted_at IS NULL
            ) ASC NULLS LAST`;
          case "price_desc":
            return sql`(
              SELECT min(pv.price_amount) FROM ${productVariants} pv
              WHERE pv.product_id = ${products.id} AND pv.deleted_at IS NULL
            ) DESC NULLS LAST`;
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
      // TODO (v0.2): order by the resolved-locale name. The translated field
      // sits inside JSONB, so a deterministic alphabetical order requires a
      // JSONB-aware expression (`translations -> '<locale>' ->> 'name'`) and
      // ideally a generated column or expression index — neither is in scope
      // for v0.1. For now we order by `slug`, which is a stable URL-safe
      // ASCII string available across locales and indexed via the unique
      // constraint, so the result is deterministic and cheap.
      return db.select().from(categories).orderBy(asc(categories.slug));
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

    /**
     * Page through inventory rows, optionally narrowed to one product. Used
     * by the admin inventory listing. We compute a separate count aggregate
     * to keep pagination cheap and predictable.
     *
     * Filters:
     *   - `productId` joins `inventory_levels → product_variants` and
     *     restricts to that product's variants.
     * Soft-deleted variants are excluded — a deleted variant's stock row
     * is dead weight to the operator. Multi-location is out of scope: rows
     * with `location_id IS NOT NULL` are filtered out so the v0.1 listing
     * matches the single-row-per-variant assumption the rest of the catalog
     * already enforces.
     */
    async listInventoryLevels(
      filters: InventoryListFilters,
    ): Promise<InventoryListResult> {
      const conditions: SQL[] = [isNull(inventoryLevels.locationId)];
      if (filters.productId) {
        const variantIds = db
          .select({ vid: productVariants.id })
          .from(productVariants)
          .where(
            and(
              eq(productVariants.productId, filters.productId),
              isNull(productVariants.deletedAt),
            ),
          );
        conditions.push(inArray(inventoryLevels.variantId, variantIds));
      } else {
        // No product filter: still hide rows for soft-deleted variants. Done
        // via a NOT IN against the soft-deleted variant ids — using a
        // subquery keeps the index path on `inventory_levels` free instead
        // of forcing an outer join.
        const deletedVariantIds = db
          .select({ vid: productVariants.id })
          .from(productVariants)
          .where(sql`${productVariants.deletedAt} IS NOT NULL`);
        conditions.push(
          sql`${inventoryLevels.variantId} NOT IN ${deletedVariantIds}`,
        );
      }
      const where = and(...conditions);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(inventoryLevels)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(inventoryLevels)
        .where(where ?? sql`true`)
        .orderBy(desc(inventoryLevels.updatedAt), asc(inventoryLevels.id))
        .limit(filters.pageSize)
        .offset(offset);
      return { rows, total };
    },

    /**
     * Run `fn` inside a Postgres transaction. The callback receives a
     * repository bound to the transaction `tx` and an audit repository
     * bound to the same `tx`, so the inventory adjustment and its audit
     * row commit (or roll back) together.
     *
     * Two repos rather than a unified one because the audit module is its
     * own bounded context per ADR-0005 — the catalog repo cannot reach into
     * `audit_log` directly.
     */
    async withTransaction<T>(
      fn: (deps: {
        catalog: CatalogRepository;
        audit: AuditRepository;
      }) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        return fn({
          catalog: createCatalogRepository(txDb),
          audit: createAuditRepository(txDb),
        });
      });
    },
  };
}

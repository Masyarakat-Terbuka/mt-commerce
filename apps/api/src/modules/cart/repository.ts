/**
 * Cart repository — Drizzle queries, no domain logic.
 *
 * Mirrors the catalog/customer repositories: returns Drizzle row types,
 * leaves DTO shaping to the service. Constructed via
 * `createCartRepository(db)` so tests can inject a fake by implementing
 * the `CartRepository` shape.
 *
 * Methods that need to run together inside a single transaction use
 * `withTransaction(fn)`, which calls `db.transaction()` and re-wraps the
 * inner `tx` as a fresh repository — the service does not touch Drizzle
 * types to compose work.
 *
 * Cross-table reads:
 *   - `getVariantSnapshot` reaches the `product_variants` table (read-only)
 *     to capture the unit price at add-time. Per ADR-0005 the cart module
 *     does not write to catalog tables; this read path exists because
 *     "capture price at add-time" is a cart concern and the alternative
 *     (ask the catalog service for a Variant, then dig out the price) is
 *     a heavier round-trip with no payoff.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  cartItems,
  carts,
  productVariants,
  type CartItemRow,
  type CartRow,
  type NewCartItemRow,
  type NewCartRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { CartStatus } from "./types.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface CartListFilters {
  status?: CartStatus;
  customerId?: string;
  page: number;
  pageSize: number;
}

export interface CartListResult {
  rows: CartRow[];
  total: number;
}

/**
 * Snapshot of a variant's pricing — exactly enough for the cart to
 * capture `unit_price_amount` and `unit_price_currency` at add-time
 * without dragging the full catalog domain shape into this module.
 */
export interface VariantPricingSnapshot {
  id: string;
  priceAmount: bigint;
  priceCurrency: string;
  /** True if the variant has been soft-deleted; cart should refuse to add. */
  deleted: boolean;
}

export interface CartRepository {
  insertCart(row: NewCartRow): Promise<CartRow>;
  getCartById(id: string): Promise<CartRow | null>;
  /**
   * Most-recent active cart for a customer. There can be more than one
   * row historically (a guest cart that was merged in, then a fresh one),
   * but the partial index supports the "latest active" lookup directly.
   */
  getActiveCartForCustomer(customerId: string): Promise<CartRow | null>;
  listCarts(filters: CartListFilters): Promise<CartListResult>;
  updateCart(
    id: string,
    patch: Partial<NewCartRow>,
  ): Promise<CartRow | null>;
  /**
   * Touch `updated_at` without altering any other column. Used after
   * mutations to line items so the parent cart's mtime reflects the change.
   */
  touchCart(id: string): Promise<CartRow | null>;

  // Items
  insertItem(row: NewCartItemRow): Promise<CartItemRow>;
  getItemById(id: string): Promise<CartItemRow | null>;
  getItemByCartAndVariant(
    cartId: string,
    variantId: string,
  ): Promise<CartItemRow | null>;
  listItemsForCart(cartId: string): Promise<CartItemRow[]>;
  listItemsForCarts(cartIds: string[]): Promise<CartItemRow[]>;
  updateItem(
    id: string,
    patch: Partial<NewCartItemRow>,
  ): Promise<CartItemRow | null>;
  deleteItem(id: string): Promise<void>;
  deleteItemsForCart(cartId: string): Promise<void>;

  // Cross-module read (catalog price snapshot)
  getVariantSnapshot(
    variantId: string,
  ): Promise<VariantPricingSnapshot | null>;

  withTransaction<T>(fn: (tx: CartRepository) => Promise<T>): Promise<T>;
}

export function createCartRepository(db: Db = defaultDb): CartRepository {
  return {
    // -------------------------------------------------------------------
    // Carts
    // -------------------------------------------------------------------
    async insertCart(row: NewCartRow): Promise<CartRow> {
      const [inserted] = await db.insert(carts).values(row).returning();
      if (!inserted) throw new Error("insertCart: returning() yielded no rows");
      return inserted;
    },

    async getCartById(id: string): Promise<CartRow | null> {
      const [row] = await db
        .select()
        .from(carts)
        .where(eq(carts.id, id))
        .limit(1);
      return row ?? null;
    },

    async getActiveCartForCustomer(
      customerId: string,
    ): Promise<CartRow | null> {
      // Newest-first so a customer who somehow ends up with more than one
      // active cart (e.g. mid-merge crash) sees the freshest one.
      const [row] = await db
        .select()
        .from(carts)
        .where(
          and(eq(carts.customerId, customerId), eq(carts.status, "active")),
        )
        .orderBy(desc(carts.createdAt))
        .limit(1);
      return row ?? null;
    },

    async listCarts(filters: CartListFilters): Promise<CartListResult> {
      const conditions: SQL[] = [];
      if (filters.status) {
        conditions.push(eq(carts.status, filters.status));
      }
      if (filters.customerId) {
        conditions.push(eq(carts.customerId, filters.customerId));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(carts)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(carts)
        .where(where ?? sql`true`)
        .orderBy(desc(carts.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async updateCart(
      id: string,
      patch: Partial<NewCartRow>,
    ): Promise<CartRow | null> {
      const [updated] = await db
        .update(carts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(carts.id, id))
        .returning();
      return updated ?? null;
    },

    async touchCart(id: string): Promise<CartRow | null> {
      const [updated] = await db
        .update(carts)
        .set({ updatedAt: new Date() })
        .where(eq(carts.id, id))
        .returning();
      return updated ?? null;
    },

    // -------------------------------------------------------------------
    // Items
    // -------------------------------------------------------------------
    async insertItem(row: NewCartItemRow): Promise<CartItemRow> {
      const [inserted] = await db.insert(cartItems).values(row).returning();
      if (!inserted) throw new Error("insertItem: returning() yielded no rows");
      return inserted;
    },

    async getItemById(id: string): Promise<CartItemRow | null> {
      const [row] = await db
        .select()
        .from(cartItems)
        .where(eq(cartItems.id, id))
        .limit(1);
      return row ?? null;
    },

    async getItemByCartAndVariant(
      cartId: string,
      variantId: string,
    ): Promise<CartItemRow | null> {
      const [row] = await db
        .select()
        .from(cartItems)
        .where(
          and(
            eq(cartItems.cartId, cartId),
            eq(cartItems.variantId, variantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listItemsForCart(cartId: string): Promise<CartItemRow[]> {
      return db
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cartId))
        .orderBy(asc(cartItems.createdAt));
    },

    async listItemsForCarts(cartIds: string[]): Promise<CartItemRow[]> {
      if (cartIds.length === 0) return [];
      // The `IN` form keeps the query plan simple; for the v0.1 admin list
      // page sizes (<=100) the planner picks the cart_id index immediately.
      return db
        .select()
        .from(cartItems)
        .where(
          // `inArray` is the standard Drizzle helper, but importing it here
          // adds a second alias that's already in use elsewhere — `sql`
          // template is just as clear and avoids the extra import surface.
          sql`${cartItems.cartId} IN (${sql.join(
            cartIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .orderBy(asc(cartItems.createdAt));
    },

    async updateItem(
      id: string,
      patch: Partial<NewCartItemRow>,
    ): Promise<CartItemRow | null> {
      const [updated] = await db
        .update(cartItems)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(cartItems.id, id))
        .returning();
      return updated ?? null;
    },

    async deleteItem(id: string): Promise<void> {
      await db.delete(cartItems).where(eq(cartItems.id, id));
    },

    async deleteItemsForCart(cartId: string): Promise<void> {
      await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
    },

    // -------------------------------------------------------------------
    // Cross-module read
    // -------------------------------------------------------------------
    async getVariantSnapshot(
      variantId: string,
    ): Promise<VariantPricingSnapshot | null> {
      const [row] = await db
        .select({
          id: productVariants.id,
          priceAmount: productVariants.priceAmount,
          priceCurrency: productVariants.priceCurrency,
          deletedAt: productVariants.deletedAt,
        })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        priceAmount: row.priceAmount,
        priceCurrency: row.priceCurrency,
        deleted: row.deletedAt !== null,
      };
    },

    async withTransaction<T>(
      fn: (tx: CartRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createCartRepository(tx as unknown as Db)),
      );
    },
  };
}


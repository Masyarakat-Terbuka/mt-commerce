/**
 * Orders repository — Drizzle queries, no domain logic.
 *
 * Mirrors the checkout/cart pattern: returns Drizzle row types, leaves
 * DTO shaping to the service. Constructed via `createOrdersRepository(db)`
 * so tests can inject an in-memory fake by implementing the
 * `OrdersRepository` shape.
 *
 * Cross-module reads (read-only):
 *   - `getOrderIntentById` reaches `order_intents` to materialise an
 *     order from an existing intent. Per ADR-0005 the orders module owns
 *     this consumption — checkout writes the intent and the orders
 *     module reads it. No write to `order_intents` happens here.
 *   - `getProductTitleTranslations` and `getVariantWithProduct` reach
 *     the catalog tables to capture title translations at order-time.
 *     Read-only; cross-module write would violate ADR-0005.
 *
 * `withTransaction(fn)` runs the callback inside a single Postgres
 * transaction. The orders service composes `createFromIntent` (read
 * intent + variant lookups + insert order/items/history) inside one
 * unit so a partial failure cannot leave a half-written order.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  kecamatan,
  kelurahan,
  kotaKabupaten,
  orderIntents,
  orderItems,
  orderStatusHistory,
  orders,
  productVariants,
  products,
  provinsi,
  type NewOrderItemRow,
  type NewOrderRow,
  type NewOrderStatusHistoryRow,
  type OrderIntentRow,
  type OrderItemRow,
  type OrderRow,
  type OrderStatusHistoryRow,
  type ProductRow,
  type ProductVariantRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { OrderStatus } from "./state.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface OrderListFilters {
  status?: OrderStatus;
  customerId?: string;
  email?: string;
  /**
   * Exact customer-facing order number (e.g. `ORD-2026-000123`). The
   * service layer normalises (trim + upper-case) before this reaches the
   * repository so the WHERE clause can stay an `eq(...)`.
   */
  orderNumber?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
}

export interface OrderListResult {
  rows: OrderRow[];
  total: number;
}

export interface VariantWithProduct {
  variant: ProductVariantRow;
  product: ProductRow;
}

/**
 * Patch shape accepted by `updateOrder`. We keep it explicit (rather
 * than `Partial<NewOrderRow>`) so the type stays load-bearing — only
 * the fields the service actually mutates are reachable.
 */
export interface OrderUpdatePatch {
  status?: OrderStatus;
  paidAt?: Date | null;
  fulfilledAt?: Date | null;
  cancelledAt?: Date | null;
  refundedAt?: Date | null;
  cancellationReason?: string | null;
}

export interface OrdersRepository {
  // Sequence
  /**
   * Reserve the next number from `order_number_seq`. Called inside the
   * order-creation transaction so a rollback gives back the gap (sequence
   * numbers are not transactional, but a missing row is harmless — order
   * numbers are advisory, not consecutive). Returns the integer; the
   * service formats `ORD-YYYY-NNNNNN`.
   */
  nextOrderNumber(): Promise<number>;

  // Orders
  insertOrder(row: NewOrderRow): Promise<OrderRow>;
  getOrderById(id: string): Promise<OrderRow | null>;
  getOrderByNumber(orderNumber: string): Promise<OrderRow | null>;
  /**
   * Same as `getOrderById` but acquires a `FOR UPDATE` row lock. Only
   * meaningful inside `withTransaction(...)`; serialises concurrent
   * transition writers.
   */
  getOrderByIdForUpdate(id: string): Promise<OrderRow | null>;
  /**
   * Defense-in-depth read: returns the existing order for an intent if
   * one already exists. Used to surface the "intent already consumed"
   * conflict cleanly before attempting an insert.
   */
  getOrderByIntentId(orderIntentId: string): Promise<OrderRow | null>;
  listOrders(filters: OrderListFilters): Promise<OrderListResult>;
  listCustomerOrders(
    customerId: string,
    page: number,
    pageSize: number,
  ): Promise<OrderListResult>;
  updateOrder(id: string, patch: OrderUpdatePatch): Promise<OrderRow | null>;

  // Order items
  insertOrderItems(rows: NewOrderItemRow[]): Promise<OrderItemRow[]>;
  listItemsForOrder(orderId: string): Promise<OrderItemRow[]>;
  listItemsForOrders(orderIds: string[]): Promise<OrderItemRow[]>;

  // Status history
  insertStatusHistory(
    row: NewOrderStatusHistoryRow,
  ): Promise<OrderStatusHistoryRow>;
  listStatusHistory(orderId: string): Promise<OrderStatusHistoryRow[]>;

  // Cross-module reads
  getOrderIntentById(id: string): Promise<OrderIntentRow | null>;
  getVariantsWithProductsByIds(
    variantIds: string[],
  ): Promise<VariantWithProduct[]>;
  /**
   * Resolve the four BPS-keyed region names in a single round-trip.
   * Called by `OrderService.createFromIntent` to enrich the address
   * snapshot AT WRITE TIME so the JSONB blob carries the names alongside
   * the ids — this is what makes the snapshot self-contained against
   * later region renames.
   *
   * Any input id may be `null` (kelurahan can be missing on an address);
   * the corresponding output is `null`. Unknown ids also produce `null`
   * — we surface the gap rather than fabricate a fallback.
   */
  resolveRegionNames(input: {
    provinsiId: string;
    kotaKabupatenId: string;
    kecamatanId: string;
    kelurahanId: string | null;
  }): Promise<{
    provinsiName: string | null;
    kotaKabupatenName: string | null;
    kecamatanName: string | null;
    kelurahanName: string | null;
  }>;

  withTransaction<T>(fn: (tx: OrdersRepository) => Promise<T>): Promise<T>;
}

export function createOrdersRepository(db: Db = defaultDb): OrdersRepository {
  return {
    async nextOrderNumber(): Promise<number> {
      // postgres-js returns a result array; the row carries the next
      // value as an integer (sequence values are int8 in Postgres but
      // fit comfortably in JS Number for any realistic merchant volume).
      const rows = await db.execute<{ next: number }>(
        sql`SELECT nextval('order_number_seq')::int AS next`,
      );
      // Drizzle's `db.execute` returns a result that is array-like; we
      // narrow defensively because the shape can differ across drivers.
      const first = (rows as unknown as { next: number }[])[0];
      if (!first || typeof first.next !== "number") {
        throw new Error("nextOrderNumber: unexpected sequence result shape");
      }
      return first.next;
    },

    async insertOrder(row: NewOrderRow): Promise<OrderRow> {
      const [inserted] = await db.insert(orders).values(row).returning();
      if (!inserted) throw new Error("insertOrder: returning() yielded no rows");
      return inserted;
    },

    async getOrderById(id: string): Promise<OrderRow | null> {
      const [row] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1);
      return row ?? null;
    },

    async getOrderByNumber(orderNumber: string): Promise<OrderRow | null> {
      const [row] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderNumber, orderNumber))
        .limit(1);
      return row ?? null;
    },

    async getOrderByIdForUpdate(id: string): Promise<OrderRow | null> {
      const [row] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async getOrderByIntentId(orderIntentId: string): Promise<OrderRow | null> {
      // `orders` does not store a direct FK to `order_intents` (the
      // intent is a one-shot snapshot; once consumed, the order is the
      // canonical record). We resolve via the audit-log row that the
      // creation transaction writes — `details.orderIntentId` carries
      // the link. A future iteration can add a dedicated column if this
      // pattern proves load-bearing.
      const rows = await db
        .select({ orderId: orderStatusHistory.orderId })
        .from(orderStatusHistory)
        .where(
          sql`${orderStatusHistory.details} ->> 'orderIntentId' = ${orderIntentId}`,
        )
        .limit(1);
      const first = rows[0];
      if (!first) return null;
      return this.getOrderById(first.orderId);
    },

    async listOrders(filters: OrderListFilters): Promise<OrderListResult> {
      const conditions: SQL[] = [];
      if (filters.status) conditions.push(eq(orders.status, filters.status));
      if (filters.customerId)
        conditions.push(eq(orders.customerId, filters.customerId));
      if (filters.email) conditions.push(eq(orders.email, filters.email));
      if (filters.orderNumber)
        conditions.push(eq(orders.orderNumber, filters.orderNumber));
      if (filters.createdFrom)
        conditions.push(gte(orders.createdAt, filters.createdFrom));
      if (filters.createdTo)
        conditions.push(lte(orders.createdAt, filters.createdTo));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(orders)
        .where(where ?? sql`true`)
        .orderBy(desc(orders.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async listCustomerOrders(
      customerId: string,
      page: number,
      pageSize: number,
    ): Promise<OrderListResult> {
      const where = eq(orders.customerId, customerId);

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(where);
      const total = countRows[0]?.count ?? 0;

      const offset = (page - 1) * pageSize;
      const rows = await db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(pageSize)
        .offset(offset);

      return { rows, total };
    },

    async updateOrder(
      id: string,
      patch: OrderUpdatePatch,
    ): Promise<OrderRow | null> {
      const [updated] = await db
        .update(orders)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(orders.id, id))
        .returning();
      return updated ?? null;
    },

    async insertOrderItems(rows: NewOrderItemRow[]): Promise<OrderItemRow[]> {
      if (rows.length === 0) return [];
      const inserted = await db.insert(orderItems).values(rows).returning();
      return inserted;
    },

    async listItemsForOrder(orderId: string): Promise<OrderItemRow[]> {
      return db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.createdAt));
    },

    async listItemsForOrders(orderIds: string[]): Promise<OrderItemRow[]> {
      if (orderIds.length === 0) return [];
      return db
        .select()
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds))
        .orderBy(asc(orderItems.createdAt));
    },

    async insertStatusHistory(
      row: NewOrderStatusHistoryRow,
    ): Promise<OrderStatusHistoryRow> {
      const [inserted] = await db
        .insert(orderStatusHistory)
        .values(row)
        .returning();
      if (!inserted)
        throw new Error("insertStatusHistory: returning() yielded no rows");
      return inserted;
    },

    async listStatusHistory(
      orderId: string,
    ): Promise<OrderStatusHistoryRow[]> {
      return db
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId))
        .orderBy(asc(orderStatusHistory.createdAt));
    },

    async getOrderIntentById(id: string): Promise<OrderIntentRow | null> {
      const [row] = await db
        .select()
        .from(orderIntents)
        .where(eq(orderIntents.id, id))
        .limit(1);
      return row ?? null;
    },

    async getVariantsWithProductsByIds(
      variantIds: string[],
    ): Promise<VariantWithProduct[]> {
      if (variantIds.length === 0) return [];
      const rows = await db
        .select({ variant: productVariants, product: products })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(inArray(productVariants.id, variantIds));
      return rows.map((r) => ({ variant: r.variant, product: r.product }));
    },

    async resolveRegionNames(input) {
      // Single query with four LEFT JOINs against a synthetic 1-row source.
      //
      // JOIN ORDER MATTERS — the LEFT JOINs walk the BPS hierarchy
      // top-down: provinsi → kota_kabupaten → kecamatan → kelurahan. The
      // joins are independent (each keys off its own input id), so
      // reordering wouldn't change correctness today; keeping them in
      // hierarchy order makes the SQL self-documenting and means adding
      // a future hierarchy-walking variant (e.g. "join kota only when
      // its provinsi_id matches") doesn't need to reshuffle anything.
      //
      // SQL (paraphrased):
      //
      //   SELECT provinsi.name        AS provinsi_name,
      //          kota_kabupaten.name  AS kota_kabupaten_name,
      //          kecamatan.name       AS kecamatan_name,
      //          kelurahan.name       AS kelurahan_name
      //   FROM   (SELECT 1) src
      //   LEFT JOIN provinsi       ON provinsi.id       = $1
      //   LEFT JOIN kota_kabupaten ON kota_kabupaten.id = $2
      //   LEFT JOIN kecamatan      ON kecamatan.id      = $3
      //   LEFT JOIN kelurahan      ON kelurahan.id      = $4
      //
      // postgres-js exposes `db.execute` with a tagged template; we use
      // it here because Drizzle's query builder does not model FROM
      // (SELECT 1) sources elegantly. The four ids travel as bind
      // parameters — no string concatenation.
      const result = await db.execute<{
        provinsi_name: string | null;
        kota_kabupaten_name: string | null;
        kecamatan_name: string | null;
        kelurahan_name: string | null;
      }>(sql`
        SELECT
          provinsi.name        AS provinsi_name,
          kota_kabupaten.name  AS kota_kabupaten_name,
          kecamatan.name       AS kecamatan_name,
          kelurahan.name       AS kelurahan_name
        FROM (SELECT 1) AS src
        LEFT JOIN provinsi       ON provinsi.id       = ${input.provinsiId}
        LEFT JOIN kota_kabupaten ON kota_kabupaten.id = ${input.kotaKabupatenId}
        LEFT JOIN kecamatan      ON kecamatan.id      = ${input.kecamatanId}
        LEFT JOIN kelurahan      ON kelurahan.id      = ${
          input.kelurahanId ?? null
        }
      `);

      // postgres-js returns rows directly array-like; defensive narrow
      // because driver shapes vary.
      const row = (result as unknown as Array<{
        provinsi_name: string | null;
        kota_kabupaten_name: string | null;
        kecamatan_name: string | null;
        kelurahan_name: string | null;
      }>)[0];

      if (!row) {
        return {
          provinsiName: null,
          kotaKabupatenName: null,
          kecamatanName: null,
          kelurahanName: null,
        };
      }

      return {
        provinsiName: row.provinsi_name,
        kotaKabupatenName: row.kota_kabupaten_name,
        kecamatanName: row.kecamatan_name,
        kelurahanName: row.kelurahan_name,
      };
    },

    async withTransaction<T>(
      fn: (tx: OrdersRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createOrdersRepository(tx as unknown as Db)),
      );
    },
  };
}

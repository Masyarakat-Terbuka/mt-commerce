/**
 * Checkout repository — Drizzle queries, no domain logic.
 *
 * Mirrors the cart and customer repositories: returns Drizzle row types,
 * leaves DTO shaping to the service. Constructed via
 * `createCheckoutRepository(db)` so tests can inject an in-memory fake by
 * implementing the `CheckoutRepository` shape.
 *
 * The transactional `complete` flow lives here as `withTransaction(fn)`:
 * the service composes its work — snapshot the cart, write the order_intent,
 * mark the cart converted, mark the checkout completed — inside one atomic
 * unit so a partial failure cannot leave the cart converted while the
 * checkout still says `awaiting_payment`.
 *
 * Cross-table reads:
 *   - `getCartSnapshotForCompletion` reaches `carts` and `cart_items` to
 *     capture line items + currency at completion time. Per ADR-0005 the
 *     checkout module does not write to cart tables; the read is in scope
 *     because "snapshot at completion" is a checkout concern.
 *   - `markCartConverted` is the lone *write* against `carts`. It sets
 *     `status='converted'` directly; this is a deliberate cross-module
 *     write justified in the README ("checkout owns the cart→order
 *     transition") because going through `cartService` would split the
 *     atomic unit across two transactions.
 *   - `getAddressForSnapshot` reaches `customer_addresses` to materialize
 *     the address payload for the order_intent snapshot. Soft-deleted
 *     addresses (`deleted_at IS NOT NULL`) are still readable here — a
 *     mid-checkout address delete should not orphan the snapshot.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  cartItems,
  carts,
  checkoutEvents,
  checkouts,
  customerAddresses,
  orderIntents,
  type CartItemRow,
  type CartRow,
  type CheckoutEventRow,
  type CheckoutRow,
  type CustomerAddressRow,
  type NewCheckoutEventRow,
  type NewCheckoutRow,
  type NewOrderIntentRow,
  type OrderIntentRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import type { CheckoutState } from "./state.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface CheckoutListFilters {
  state?: CheckoutState;
  customerId?: string;
  page: number;
  pageSize: number;
}

export interface CheckoutListResult {
  rows: CheckoutRow[];
  total: number;
}

/**
 * Snapshot of cart + items captured at completion time. Returned as plain
 * row types so the service can shape the JSON snapshot without the repo
 * having to know about money/json conventions.
 */
export interface CartSnapshotForCompletion {
  cart: CartRow;
  items: CartItemRow[];
}

export interface CheckoutRepository {
  // Checkouts
  insertCheckout(row: NewCheckoutRow): Promise<CheckoutRow>;
  getCheckoutById(id: string): Promise<CheckoutRow | null>;
  listCheckouts(filters: CheckoutListFilters): Promise<CheckoutListResult>;
  updateCheckout(
    id: string,
    patch: Partial<NewCheckoutRow>,
  ): Promise<CheckoutRow | null>;

  // Audit log
  insertEvent(row: NewCheckoutEventRow): Promise<CheckoutEventRow>;
  listEvents(checkoutId: string): Promise<CheckoutEventRow[]>;

  // Order-intent terminal write
  insertOrderIntent(row: NewOrderIntentRow): Promise<OrderIntentRow>;
  getOrderIntentByCheckoutId(checkoutId: string): Promise<OrderIntentRow | null>;

  // Cross-module reads (carts, addresses) — service owns the snapshotting.
  getCartSnapshotForCompletion(
    cartId: string,
  ): Promise<CartSnapshotForCompletion | null>;
  getAddressForSnapshot(addressId: string): Promise<CustomerAddressRow | null>;
  /** Cross-module write — see file header for the rationale. */
  markCartConverted(cartId: string): Promise<void>;

  withTransaction<T>(fn: (tx: CheckoutRepository) => Promise<T>): Promise<T>;
}

export function createCheckoutRepository(db: Db = defaultDb): CheckoutRepository {
  return {
    // ----- Checkouts ------------------------------------------------------
    async insertCheckout(row: NewCheckoutRow): Promise<CheckoutRow> {
      const [inserted] = await db.insert(checkouts).values(row).returning();
      if (!inserted)
        throw new Error("insertCheckout: returning() yielded no rows");
      return inserted;
    },

    async getCheckoutById(id: string): Promise<CheckoutRow | null> {
      const [row] = await db
        .select()
        .from(checkouts)
        .where(eq(checkouts.id, id))
        .limit(1);
      return row ?? null;
    },

    async listCheckouts(
      filters: CheckoutListFilters,
    ): Promise<CheckoutListResult> {
      const conditions: SQL[] = [];
      if (filters.state) {
        conditions.push(eq(checkouts.state, filters.state));
      }
      if (filters.customerId) {
        conditions.push(eq(checkouts.customerId, filters.customerId));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(checkouts)
        .where(where ?? sql`true`);
      const total = countRows[0]?.count ?? 0;

      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await db
        .select()
        .from(checkouts)
        .where(where ?? sql`true`)
        .orderBy(desc(checkouts.createdAt))
        .limit(filters.pageSize)
        .offset(offset);

      return { rows, total };
    },

    async updateCheckout(
      id: string,
      patch: Partial<NewCheckoutRow>,
    ): Promise<CheckoutRow | null> {
      const [updated] = await db
        .update(checkouts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(checkouts.id, id))
        .returning();
      return updated ?? null;
    },

    // ----- Audit log ------------------------------------------------------
    async insertEvent(
      row: NewCheckoutEventRow,
    ): Promise<CheckoutEventRow> {
      const [inserted] = await db.insert(checkoutEvents).values(row).returning();
      if (!inserted)
        throw new Error("insertEvent: returning() yielded no rows");
      return inserted;
    },

    async listEvents(checkoutId: string): Promise<CheckoutEventRow[]> {
      return db
        .select()
        .from(checkoutEvents)
        .where(eq(checkoutEvents.checkoutId, checkoutId))
        .orderBy(asc(checkoutEvents.createdAt));
    },

    // ----- Order intent ---------------------------------------------------
    async insertOrderIntent(
      row: NewOrderIntentRow,
    ): Promise<OrderIntentRow> {
      const [inserted] = await db.insert(orderIntents).values(row).returning();
      if (!inserted)
        throw new Error("insertOrderIntent: returning() yielded no rows");
      return inserted;
    },

    async getOrderIntentByCheckoutId(
      checkoutId: string,
    ): Promise<OrderIntentRow | null> {
      const [row] = await db
        .select()
        .from(orderIntents)
        .where(eq(orderIntents.checkoutId, checkoutId))
        .limit(1);
      return row ?? null;
    },

    // ----- Cross-module reads/writes -------------------------------------
    async getCartSnapshotForCompletion(
      cartId: string,
    ): Promise<CartSnapshotForCompletion | null> {
      const [cart] = await db
        .select()
        .from(carts)
        .where(eq(carts.id, cartId))
        .limit(1);
      if (!cart) return null;
      const items = await db
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, cartId))
        .orderBy(asc(cartItems.createdAt));
      return { cart, items };
    },

    async getAddressForSnapshot(
      addressId: string,
    ): Promise<CustomerAddressRow | null> {
      const [row] = await db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.id, addressId))
        .limit(1);
      return row ?? null;
    },

    async markCartConverted(cartId: string): Promise<void> {
      await db
        .update(carts)
        .set({ status: "converted", updatedAt: new Date() })
        .where(eq(carts.id, cartId));
    },

    async withTransaction<T>(
      fn: (tx: CheckoutRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createCheckoutRepository(tx as unknown as Db)),
      );
    },
  };
}

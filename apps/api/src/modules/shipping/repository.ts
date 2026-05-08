/**
 * Shipping repository — Drizzle queries, no domain logic.
 *
 * Returns Drizzle row types; the service shapes domain objects via
 * `mappers.ts`. Constructed via `createShippingRepository(db)` so tests
 * can inject a fake by implementing the `ShippingRepository` shape.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  fulfillments,
  shippingMethods,
  type FulfillmentRow,
  type NewFulfillmentRow,
  type NewShippingMethodRow,
  type ShippingMethodRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";
import {
  createAuditRepository,
  type AuditRepository,
} from "../audit/repository.js";
import type { FulfillmentStatus } from "./types.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

/**
 * Patch shape accepted by `updateFulfillment`. Explicit (rather than
 * `Partial<NewFulfillmentRow>`) so the type stays load-bearing — only the
 * fields the service actually mutates on a status transition are reachable.
 */
export interface FulfillmentUpdatePatch {
  status?: FulfillmentStatus;
  trackingCode?: string | null;
  trackedAt?: Date | null;
  deliveredAt?: Date | null;
}

export interface ShippingRepository {
  // Methods
  insertMethod(row: NewShippingMethodRow): Promise<ShippingMethodRow>;
  getMethodById(id: string): Promise<ShippingMethodRow | null>;
  getMethodByCode(code: string): Promise<ShippingMethodRow | null>;
  listMethods(opts: { activeOnly: boolean }): Promise<ShippingMethodRow[]>;
  updateMethod(
    id: string,
    patch: Partial<NewShippingMethodRow>,
  ): Promise<ShippingMethodRow | null>;
  /** Soft-delete (sets `deleted_at` and `is_active = false`). */
  softDeleteMethod(id: string): Promise<ShippingMethodRow | null>;

  // Fulfillments
  insertFulfillment(row: NewFulfillmentRow): Promise<FulfillmentRow>;
  getFulfillmentById(id: string): Promise<FulfillmentRow | null>;
  /**
   * Same as `getFulfillmentById` but acquires a `FOR UPDATE` row lock.
   * Only meaningful inside `withTransaction(...)`; serialises concurrent
   * transition writers (rare in practice — admins act one-at-a-time on
   * a fulfillment — but defense-in-depth.)
   */
  getFulfillmentByIdForUpdate(id: string): Promise<FulfillmentRow | null>;
  listFulfillmentsByOrderId(orderId: string): Promise<FulfillmentRow[]>;
  /**
   * Batch read for embedding fulfillments on a list of orders. Returns
   * every fulfillment whose `order_id` is in the input set, ordered by
   * created_at. Empty input returns `[]` without a round-trip.
   */
  listFulfillmentsForOrders(orderIds: string[]): Promise<FulfillmentRow[]>;
  updateFulfillment(
    id: string,
    patch: FulfillmentUpdatePatch,
  ): Promise<FulfillmentRow | null>;

  /**
   * Run `fn` inside a single Postgres transaction. The callback receives
   * a tx-scoped shipping repo AND a tx-scoped audit repo so writes that
   * must commit together (a status transition + its audit row) cannot
   * land out of sync. The audit repo is provided here rather than reached
   * for at the call site so the cross-module bounded context (ADR-0005)
   * stays clean — the shipping service does not import audit repository
   * factories ad hoc.
   */
  withTransaction<T>(
    fn: (deps: {
      shipping: ShippingRepository;
      audit: AuditRepository;
    }) => Promise<T>,
  ): Promise<T>;
}

export function createShippingRepository(
  db: Db = defaultDb,
): ShippingRepository {
  return {
    async insertMethod(row: NewShippingMethodRow): Promise<ShippingMethodRow> {
      const [inserted] = await db.insert(shippingMethods).values(row).returning();
      if (!inserted) throw new Error("insertMethod: returning() yielded no rows");
      return inserted;
    },

    async getMethodById(id: string): Promise<ShippingMethodRow | null> {
      const [row] = await db
        .select()
        .from(shippingMethods)
        .where(eq(shippingMethods.id, id))
        .limit(1);
      return row ?? null;
    },

    async getMethodByCode(code: string): Promise<ShippingMethodRow | null> {
      const [row] = await db
        .select()
        .from(shippingMethods)
        .where(eq(shippingMethods.code, code))
        .limit(1);
      return row ?? null;
    },

    async listMethods(opts: {
      activeOnly: boolean;
    }): Promise<ShippingMethodRow[]> {
      // `activeOnly` filters both `is_active = true` and
      // `deleted_at IS NULL`. The `shipping_methods_active_idx` supports
      // the storefront's hot path; on the admin "show me everything"
      // path we return the full set ordered by code.
      if (opts.activeOnly) {
        return db
          .select()
          .from(shippingMethods)
          .where(
            and(
              eq(shippingMethods.isActive, true),
              isNull(shippingMethods.deletedAt),
            ),
          )
          .orderBy(asc(shippingMethods.code));
      }
      return db
        .select()
        .from(shippingMethods)
        .orderBy(asc(shippingMethods.code));
    },

    async updateMethod(
      id: string,
      patch: Partial<NewShippingMethodRow>,
    ): Promise<ShippingMethodRow | null> {
      const [updated] = await db
        .update(shippingMethods)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(shippingMethods.id, id))
        .returning();
      return updated ?? null;
    },

    async softDeleteMethod(id: string): Promise<ShippingMethodRow | null> {
      const [updated] = await db
        .update(shippingMethods)
        .set({
          deletedAt: new Date(),
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(shippingMethods.id, id))
        .returning();
      return updated ?? null;
    },

    async insertFulfillment(row: NewFulfillmentRow): Promise<FulfillmentRow> {
      const [inserted] = await db
        .insert(fulfillments)
        .values(row)
        .returning();
      if (!inserted)
        throw new Error("insertFulfillment: returning() yielded no rows");
      return inserted;
    },

    async getFulfillmentById(id: string): Promise<FulfillmentRow | null> {
      const [row] = await db
        .select()
        .from(fulfillments)
        .where(eq(fulfillments.id, id))
        .limit(1);
      return row ?? null;
    },

    async getFulfillmentByIdForUpdate(
      id: string,
    ): Promise<FulfillmentRow | null> {
      const [row] = await db
        .select()
        .from(fulfillments)
        .where(eq(fulfillments.id, id))
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async listFulfillmentsByOrderId(
      orderId: string,
    ): Promise<FulfillmentRow[]> {
      return db
        .select()
        .from(fulfillments)
        .where(eq(fulfillments.orderId, orderId))
        .orderBy(asc(fulfillments.createdAt));
    },

    async listFulfillmentsForOrders(
      orderIds: string[],
    ): Promise<FulfillmentRow[]> {
      if (orderIds.length === 0) return [];
      // `inArray` requires a non-empty array; the early return above
      // protects callers that pass `[]`.
      return db
        .select()
        .from(fulfillments)
        .where(inArray(fulfillments.orderId, orderIds))
        .orderBy(asc(fulfillments.createdAt));
    },

    async updateFulfillment(
      id: string,
      patch: FulfillmentUpdatePatch,
    ): Promise<FulfillmentRow | null> {
      const [updated] = await db
        .update(fulfillments)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(fulfillments.id, id))
        .returning();
      return updated ?? null;
    },

    async withTransaction<T>(
      fn: (deps: {
        shipping: ShippingRepository;
        audit: AuditRepository;
      }) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        return fn({
          shipping: createShippingRepository(txDb),
          audit: createAuditRepository(txDb),
        });
      });
    },
  };
}

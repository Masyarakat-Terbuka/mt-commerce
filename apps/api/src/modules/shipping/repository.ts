/**
 * Shipping repository — Drizzle queries, no domain logic.
 *
 * Returns Drizzle row types; the service shapes domain objects via
 * `mappers.ts`. Constructed via `createShippingRepository(db)` so tests
 * can inject a fake by implementing the `ShippingRepository` shape.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
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

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

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

  withTransaction<T>(fn: (tx: ShippingRepository) => Promise<T>): Promise<T>;
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

    async withTransaction<T>(
      fn: (tx: ShippingRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createShippingRepository(tx as unknown as Db)),
      );
    },
  };
}

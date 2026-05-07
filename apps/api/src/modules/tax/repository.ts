/**
 * Tax repository — Drizzle queries, no domain logic.
 *
 * Returns Drizzle row types; the service composes those into domain
 * objects via `mappers.ts`. Constructed via `createTaxRateRepository(db)`
 * so tests can inject a fake by implementing the `TaxRateRepository` shape.
 *
 * The "set default" mutation is the only multi-statement work in this
 * module: clearing an existing default and setting a new one must run in
 * a single transaction so the partial unique index on
 * `(currency) WHERE is_default = true AND archived_at IS NULL` is never
 * temporarily violated. The service uses `withTransaction` to compose
 * those statements.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  taxRates,
  type NewTaxRateRow,
  type TaxRateRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export interface TaxRateRepository {
  insertRate(row: NewTaxRateRow): Promise<TaxRateRow>;
  getRateById(id: string): Promise<TaxRateRow | null>;
  getRateByCode(code: string): Promise<TaxRateRow | null>;
  /**
   * Returns the single default, non-archived rate for a currency, or null.
   * Backed by `tax_rates_default_per_currency_unique_idx`, so the planner
   * resolves this with a single index lookup.
   */
  getDefaultRate(currency: string): Promise<TaxRateRow | null>;
  listRates(opts: { activeOnly: boolean }): Promise<TaxRateRow[]>;
  updateRate(
    id: string,
    patch: Partial<NewTaxRateRow>,
  ): Promise<TaxRateRow | null>;
  /**
   * Clears the default flag on every non-archived rate for the given
   * currency. Used by the service inside the same transaction that sets
   * a new default.
   */
  clearDefaultsForCurrency(currency: string): Promise<void>;

  withTransaction<T>(fn: (tx: TaxRateRepository) => Promise<T>): Promise<T>;
}

export function createTaxRateRepository(db: Db = defaultDb): TaxRateRepository {
  return {
    async insertRate(row: NewTaxRateRow): Promise<TaxRateRow> {
      const [inserted] = await db.insert(taxRates).values(row).returning();
      if (!inserted) throw new Error("insertRate: returning() yielded no rows");
      return inserted;
    },

    async getRateById(id: string): Promise<TaxRateRow | null> {
      const [row] = await db
        .select()
        .from(taxRates)
        .where(eq(taxRates.id, id))
        .limit(1);
      return row ?? null;
    },

    async getRateByCode(code: string): Promise<TaxRateRow | null> {
      const [row] = await db
        .select()
        .from(taxRates)
        .where(eq(taxRates.code, code))
        .limit(1);
      return row ?? null;
    },

    async getDefaultRate(currency: string): Promise<TaxRateRow | null> {
      const [row] = await db
        .select()
        .from(taxRates)
        .where(
          and(
            eq(taxRates.currency, currency),
            eq(taxRates.isDefault, true),
            isNull(taxRates.archivedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listRates(opts: { activeOnly: boolean }): Promise<TaxRateRow[]> {
      // `activeOnly` filters out archived rows. The list ordering is
      // `(currency asc, code asc)` so the admin sees rates grouped by
      // currency in a stable order.
      const where = opts.activeOnly ? isNull(taxRates.archivedAt) : sql`true`;
      return db
        .select()
        .from(taxRates)
        .where(where)
        .orderBy(asc(taxRates.currency), asc(taxRates.code));
    },

    async updateRate(
      id: string,
      patch: Partial<NewTaxRateRow>,
    ): Promise<TaxRateRow | null> {
      const [updated] = await db
        .update(taxRates)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(taxRates.id, id))
        .returning();
      return updated ?? null;
    },

    async clearDefaultsForCurrency(currency: string): Promise<void> {
      await db
        .update(taxRates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(taxRates.currency, currency),
            eq(taxRates.isDefault, true),
            isNull(taxRates.archivedAt),
          ),
        );
    },

    async withTransaction<T>(
      fn: (tx: TaxRateRepository) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) =>
        fn(createTaxRateRepository(tx as unknown as Db)),
      );
    },
  };
}

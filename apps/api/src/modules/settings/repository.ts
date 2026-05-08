/**
 * Settings repository — Drizzle queries, no domain logic.
 *
 * Returns Drizzle row types enriched with the four resolved region NAMES
 * from a single LEFT-JOIN read. The service composes those into the
 * domain object via `mappers.ts`.
 *
 * The store_settings table holds at most one row, keyed by the sentinel
 * id `'singleton'` (CHECK + PRIMARY KEY enforce that). The repository's
 * read path returns the row OR null; the service is responsible for
 * lazily inserting the default row on first read so callers never see a
 * "settings not found" branch.
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "../../db/client.js";
import {
  kecamatan,
  kelurahan,
  kotaKabupaten,
  provinsi,
  storeSettings,
  type NewStoreSettingsRow,
  type StoreSettingsRow,
} from "../../db/schema/index.js";
import type * as schema from "../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

export const SINGLETON_ID = "singleton";

export type StoreSettingsRowWithRegions = StoreSettingsRow & {
  shippingOriginProvinsiName: string | null;
  shippingOriginKotaKabupatenName: string | null;
  shippingOriginKecamatanName: string | null;
  shippingOriginKelurahanName: string | null;
};

export interface SettingsRepository {
  /**
   * Returns the singleton row with resolved region names, or `null` when
   * the row has not been inserted yet (first-ever read).
   */
  getSingleton(): Promise<StoreSettingsRowWithRegions | null>;
  /**
   * Insert the singleton row. Used exactly once on first read; the
   * service layer makes the call inside a "guard then insert" sequence so
   * concurrent first-reads converge on the same row via the PRIMARY KEY
   * unique violation (caller catches and re-reads).
   */
  insertSingleton(row: NewStoreSettingsRow): Promise<StoreSettingsRow>;
  updateSingleton(
    patch: Partial<NewStoreSettingsRow>,
  ): Promise<StoreSettingsRow | null>;
}

export function createSettingsRepository(
  db: Db = defaultDb,
): SettingsRepository {
  return {
    async getSingleton(): Promise<StoreSettingsRowWithRegions | null> {
      // LEFT JOIN four region tables in one round-trip. Each join keys off
      // the row's own `*_id` so the chain stays flat (no walking the BPS
      // hierarchy). A null `*_id` produces a null `*_name` — the mapper
      // collapses that to `undefined`.
      const rows = await db
        .select({
          row: storeSettings,
          provinsiName: provinsi.name,
          kotaKabupatenName: kotaKabupaten.name,
          kecamatanName: kecamatan.name,
          kelurahanName: kelurahan.name,
        })
        .from(storeSettings)
        .leftJoin(
          provinsi,
          eq(provinsi.id, storeSettings.shippingOriginProvinsiId),
        )
        .leftJoin(
          kotaKabupaten,
          eq(kotaKabupaten.id, storeSettings.shippingOriginKotaKabupatenId),
        )
        .leftJoin(
          kecamatan,
          eq(kecamatan.id, storeSettings.shippingOriginKecamatanId),
        )
        .leftJoin(
          kelurahan,
          eq(kelurahan.id, storeSettings.shippingOriginKelurahanId),
        )
        .where(eq(storeSettings.id, SINGLETON_ID))
        .limit(1);

      const first = rows[0];
      if (!first) return null;
      return {
        ...first.row,
        shippingOriginProvinsiName: first.provinsiName,
        shippingOriginKotaKabupatenName: first.kotaKabupatenName,
        shippingOriginKecamatanName: first.kecamatanName,
        shippingOriginKelurahanName: first.kelurahanName,
      };
    },

    async insertSingleton(row: NewStoreSettingsRow): Promise<StoreSettingsRow> {
      const [inserted] = await db.insert(storeSettings).values(row).returning();
      if (!inserted) {
        throw new Error("insertSingleton: returning() yielded no rows");
      }
      return inserted;
    },

    async updateSingleton(
      patch: Partial<NewStoreSettingsRow>,
    ): Promise<StoreSettingsRow | null> {
      const [updated] = await db
        .update(storeSettings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(storeSettings.id, SINGLETON_ID))
        .returning();
      return updated ?? null;
    },
  };
}

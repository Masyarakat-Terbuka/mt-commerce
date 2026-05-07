/**
 * Provinsi — Indonesian province. Top of the four-level admin region tree:
 *
 *   provinsi → kota_kabupaten → kecamatan → kelurahan
 *
 * The primary key IS the BPS code (e.g. "31" for DKI Jakarta), not a ULID.
 * BPS codes are stable, externally meaningful identifiers; using them as the
 * PK lets us:
 *   - join against external data (BPS bulk imports, courier rate tables)
 *     without a translation step;
 *   - keep customer-address rows portable when the seed dataset is replaced
 *     with the full BPS dataset (the IDs in `customer_addresses` survive).
 *
 * There is intentionally no separate `code` column. An earlier draft kept
 * one, but `id` and `code` carried the same value at every write — the
 * duplication added an index, a uniqueness constraint, and a class of
 * "did I just compare the wrong field?" bugs without buying anything. If a
 * future use case ever needs a non-BPS surrogate, add it then; until then
 * `id` is the canonical BPS code.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const provinsi = pgTable("provinsi", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProvinsiRow = typeof provinsi.$inferSelect;
export type NewProvinsiRow = typeof provinsi.$inferInsert;

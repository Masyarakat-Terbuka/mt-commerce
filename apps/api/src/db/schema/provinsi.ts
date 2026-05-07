/**
 * Provinsi — Indonesian province. Top of the four-level admin region tree:
 *
 *   provinsi → kota_kabupaten → kecamatan → kelurahan
 *
 * The primary key is the BPS code (e.g. "31" for DKI Jakarta), NOT a ULID.
 * BPS codes are stable, externally meaningful identifiers; using them as the
 * PK lets us:
 *   - join against external data (BPS bulk imports, courier rate tables)
 *     without a translation step;
 *   - keep customer-address rows portable when the seed dataset is replaced
 *     with the full BPS dataset (the IDs in `customer_addresses` survive).
 *
 * `code` is duplicated as a separate column (and unique) so the rest of the
 * system can refer to "the BPS code" without coupling to PK identity. They
 * carry the same value at write time today.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const provinsi = pgTable("provinsi", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProvinsiRow = typeof provinsi.$inferSelect;
export type NewProvinsiRow = typeof provinsi.$inferInsert;

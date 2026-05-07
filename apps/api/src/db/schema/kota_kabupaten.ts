/**
 * Kota / Kabupaten — second level of the Indonesian admin tree. A "kota" is
 * a city; a "kabupaten" is a regency. Both sit immediately under provinsi
 * and are distinguished here by `kind`.
 *
 * Same PK strategy as `provinsi`: the BPS code IS the id (e.g. "3171" for
 * Kota Jakarta Pusat). See `provinsi.ts` for the rationale and for why
 * there is no separate `code` column.
 *
 * Index on `provinsi_id` covers the "list children of this province"
 * dropdown query, which is the only access pattern the storefront uses.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { provinsi } from "./provinsi.js";

export const kotaKabupaten = pgTable(
  "kota_kabupaten",
  {
    id: text("id").primaryKey(),
    provinsiId: text("provinsi_id")
      .notNull()
      .references(() => provinsi.id),
    name: text("name").notNull(),
    /** "kota" (city) or "kabupaten" (regency). Validated at the boundary. */
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    provinsiIdIdx: index("kota_kabupaten_provinsi_id_idx").on(table.provinsiId),
  }),
);

export type KotaKabupatenRow = typeof kotaKabupaten.$inferSelect;
export type NewKotaKabupatenRow = typeof kotaKabupaten.$inferInsert;

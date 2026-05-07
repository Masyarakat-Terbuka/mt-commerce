/**
 * Kecamatan — district, third level of the Indonesian admin tree. Sits under
 * kota_kabupaten. BPS code IS the PK (e.g. "317101" for Gambir). See
 * `provinsi.ts` for why there is no separate `code` column.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { kotaKabupaten } from "./kota_kabupaten.js";

export const kecamatan = pgTable(
  "kecamatan",
  {
    id: text("id").primaryKey(),
    kotaKabupatenId: text("kota_kabupaten_id")
      .notNull()
      .references(() => kotaKabupaten.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    kotaKabupatenIdIdx: index("kecamatan_kota_kabupaten_id_idx").on(
      table.kotaKabupatenId,
    ),
  }),
);

export type KecamatanRow = typeof kecamatan.$inferSelect;
export type NewKecamatanRow = typeof kecamatan.$inferInsert;

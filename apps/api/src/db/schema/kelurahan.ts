/**
 * Kelurahan — sub-district, fourth and final level of the Indonesian admin
 * tree. Sits under kecamatan. BPS code is the PK.
 *
 * The `postal_code` column lives here (rather than on `kecamatan` or above)
 * because postal codes in Indonesia are kelurahan-level: a single kecamatan
 * can span multiple postal codes, and a single kelurahan has exactly one.
 *
 * We index `postal_code` because the postal-code lookup endpoint is a hot
 * path on the storefront's address autofill. Multiple kelurahans can share
 * the same postal code (rare but possible), so the index is non-unique.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { kecamatan } from "./kecamatan.js";

export const kelurahan = pgTable(
  "kelurahan",
  {
    id: text("id").primaryKey(),
    kecamatanId: text("kecamatan_id")
      .notNull()
      .references(() => kecamatan.id),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    /** Five-digit Indonesian postal code; validated at the HTTP boundary. */
    postalCode: text("postal_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    kecamatanIdIdx: index("kelurahan_kecamatan_id_idx").on(table.kecamatanId),
    postalCodeIdx: index("kelurahan_postal_code_idx").on(table.postalCode),
  }),
);

export type KelurahanRow = typeof kelurahan.$inferSelect;
export type NewKelurahanRow = typeof kelurahan.$inferInsert;

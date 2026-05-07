/**
 * Inventory level — per-variant, per-location stock state.
 *
 * v0.1 ships a single-location model: callers leave `location_id` NULL and
 * read/write the one row that exists per variant. The `location_id` column is
 * here from day one so multi-location fulfillment is an additive change later
 * (no schema migration on the hot path).
 *
 * The unique constraint on `(variant_id, location_id)` is split between a
 * partial unique index for NULL `location_id` (Postgres treats NULLs as
 * distinct in standard unique indexes — so without the partial we could
 * insert two NULL-location rows for the same variant) and a non-NULL unique
 * index for the multi-location case. Both are declared via the migration
 * since drizzle-kit's `uniqueIndex` does not natively express a partial
 * predicate at schema-time today; the constraints are still enforced at the
 * database level.
 */
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { productVariants } from "./product_variants.js";

export const inventoryLevels = pgTable("inventory_levels", {
  id: text("id").primaryKey(),
  variantId: text("variant_id")
    .notNull()
    .references(() => productVariants.id, { onDelete: "cascade" }),
  // Nullable for v1's single-location store. Populated when multi-location
  // ships; the unique constraints in the migration prevent duplicates per
  // (variant, location) including the NULL-location case.
  locationId: text("location_id"),
  available: integer("available").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type InventoryLevelRow = typeof inventoryLevels.$inferSelect;
export type NewInventoryLevelRow = typeof inventoryLevels.$inferInsert;

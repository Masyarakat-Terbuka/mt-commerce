/**
 * Category taxonomy. Categories form a tree via the optional self-referencing
 * `parent_id`. Hierarchy is intentionally simple — a single parent per
 * category. Shoppers reach categories through the `slug`, which must be
 * URL-safe and unique.
 *
 * Hard delete is permitted (see service layer). Categories are not financial
 * data and do not need an audit trail.
 */
import {
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Self-reference: a category may belong to a parent category. We type the
  // reference via `AnyPgColumn` because the table itself is not yet typed at
  // the point Drizzle inspects the column callback.
  parentId: text("parent_id").references((): AnyPgColumn => categories.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;

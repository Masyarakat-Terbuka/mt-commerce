/**
 * Category taxonomy. Categories form a tree via the optional self-referencing
 * `parent_id`. Hierarchy is intentionally simple — a single parent per
 * category. Shoppers reach categories through the `slug`, which must be
 * URL-safe and unique.
 *
 * Localized display names (`name`) live in the `translations` JSONB column
 * per ADR-0010. The slug stays a single value because it is part of the
 * URL space and not a localized string.
 *
 * Hard delete is permitted (see service layer). Categories are not financial
 * data and do not need an audit trail.
 */
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Translations } from "./translations.js";

export type CategoryTranslationField = "name";
export type CategoryTranslations = Translations<CategoryTranslationField>;

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  /**
   * Localized category names keyed by locale. See ADR-0010 for the shape
   * and the resolver contract.
   */
  translations: jsonb("translations")
    .$type<CategoryTranslations>()
    .notNull()
    .default({}),
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

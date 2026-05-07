/**
 * Product — the top-level catalog entity. A product is a sellable item that
 * groups one or more variants. Money fields live on the variant (per ADR-0007
 * a `price_amount` is paired with a currency); the product carries only a
 * `default_currency` hint that variant creation may default to.
 *
 * Lifecycle:
 *   - `status` controls visibility (draft/active/archived). Storefront queries
 *     should restrict to `active` only.
 *   - `deleted_at` is the soft-delete marker. Audit semantics are out of scope
 *     for v0.1; the audit_log integration lands separately.
 */
import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const productStatus = pgEnum("product_status", [
  "draft",
  "active",
  "archived",
]);

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  status: productStatus("status").notNull().default("draft"),
  defaultCurrency: text("default_currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;

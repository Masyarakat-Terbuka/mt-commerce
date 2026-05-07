/**
 * Product — the top-level catalog entity. A product is a sellable item that
 * groups one or more variants. Money fields live on the variant (per ADR-0007
 * a `price_amount` is paired with a currency); the product carries only a
 * `default_currency` hint that variant creation may default to.
 *
 * Localized strings (`title`, `description`) live in the `translations` JSONB
 * column per ADR-0010. The shape is `{ "<locale>": { title, description } }`
 * with `id` (Bahasa Indonesia) as the default locale; the catalog service's
 * resolver flattens it to the requested locale at read time so the rest of
 * the system never deals with the JSONB shape directly.
 *
 * Lifecycle:
 *   - `status` controls visibility (draft/active/archived). Storefront queries
 *     should restrict to `active` only.
 *   - `deleted_at` is the soft-delete marker. Audit semantics are out of scope
 *     for v0.1; the audit_log integration lands separately.
 */
import { jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Translations } from "./translations.js";

export const productStatus = pgEnum("product_status", [
  "draft",
  "active",
  "archived",
]);

export type ProductTranslationField = "title" | "description";
export type ProductTranslations = Translations<ProductTranslationField>;

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  /**
   * Localized strings keyed by locale. Per ADR-0010 the JSONB column is
   * `NOT NULL DEFAULT '{}'::jsonb`, and the typed shape pins the
   * translatable field set so misspellings surface at the boundary
   * rather than at runtime. The resolver in `modules/catalog/i18n.ts`
   * flattens the JSONB to the requested locale.
   */
  translations: jsonb("translations")
    .$type<ProductTranslations>()
    .notNull()
    .default({}),
  status: productStatus("status").notNull().default("draft"),
  defaultCurrency: text("default_currency").notNull(),
  /**
   * Primary product image URL. Nullable while images are managed externally
   * (Unsplash/CDN URLs in seeds, eventually a media-upload pipeline). The
   * storefront falls back to a neutral placeholder when null. A separate
   * `product_images` table is intentionally deferred: most v0.1 catalogs
   * carry one hero photo per product, and a single nullable column keeps
   * mappers, wire shapes, and the SDK simple. The follow-up upload module
   * will introduce the multi-image table and migrate this column then.
   */
  imageUrl: text("image_url"),
  /**
   * Alt text for `image_url`. Stored as a single string for now; the
   * follow-up move to localized alt text will fold this into the
   * `translations` column under each locale's slot.
   */
  imageAlt: text("image_alt"),
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

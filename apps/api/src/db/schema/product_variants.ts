/**
 * Product variant — the priced, sellable SKU under a product. Every product
 * has at least one variant (the "default" variant, where `translations` is
 * empty); configurable products have many.
 *
 * Localized strings (`title` only) live in the `translations` JSONB column
 * per ADR-0010. An empty JSONB (`{}`) means the variant has no display
 * label and the storefront falls back to the parent product's title — that
 * is the "default variant" case.
 *
 * Money is represented per ADR-0007: `price_amount` is `bigint` in the
 * smallest unit of `price_currency`. For Indonesian Rupiah, that is whole
 * rupiah. Mappers in the catalog module convert these two columns to the
 * shared `Money` value object.
 *
 * `compare_at_amount` is the optional crossed-out price for promotions.
 * It shares `price_currency` (cross-currency comparison is forbidden).
 */
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { products } from "./products.js";
import type { Translations } from "./translations.js";

export type VariantTranslationField = "title";
export type VariantTranslations = Translations<VariantTranslationField>;

export const productVariants = pgTable("product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  sku: text("sku").notNull().unique(),
  /**
   * Localized variant labels keyed by locale. An empty JSONB indicates
   * the default/single variant under a product. See ADR-0010 for the
   * shape and the resolver contract.
   */
  translations: jsonb("translations")
    .$type<VariantTranslations>()
    .notNull()
    .default({}),
  priceAmount: bigint("price_amount", { mode: "bigint" }).notNull(),
  priceCurrency: text("price_currency").notNull(),
  compareAtAmount: bigint("compare_at_amount", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type ProductVariantRow = typeof productVariants.$inferSelect;
export type NewProductVariantRow = typeof productVariants.$inferInsert;

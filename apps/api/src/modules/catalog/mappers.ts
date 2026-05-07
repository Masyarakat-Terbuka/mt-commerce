/**
 * Drizzle row → domain type mappers.
 *
 * Two collapses happen here:
 *
 *   1. The two-column `(price_amount, price_currency)` storage shape becomes
 *      a single `Money` value so the rest of the system never deals with raw
 *      bigints.
 *   2. The locale-keyed `translations` JSONB column (per ADR-0010) is
 *      flattened to plain strings (`title`, `description`, `name`) for the
 *      requested locale, falling back through the chain documented in
 *      `i18n.ts`. The locale defaults to `DEFAULT_LOCALE` (`"id"`) when the
 *      caller does not specify one.
 *
 * Inverse mappers (domain → insert) live next to the schemas they target
 * because they are simple field renames; only the read direction is
 * non-trivial enough to justify dedicated functions.
 */
import type { Money } from "@mt-commerce/core/money";
import type {
  CategoryRow,
  InventoryLevelRow,
  ProductRow,
  ProductVariantRow,
} from "../../db/schema/index.js";
import { DEFAULT_LOCALE, resolveTranslations } from "./i18n.js";
import type {
  Category,
  InventoryLevel,
  Product,
  ProductStatus,
  Variant,
} from "./types.js";

export function toCategory(
  row: CategoryRow,
  locale: string = DEFAULT_LOCALE,
): Category {
  const resolved = resolveTranslations<"name">(row.translations, locale);
  return {
    id: row.id,
    slug: row.slug,
    name: resolved.name ?? "",
    parentId: row.parentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVariant(
  row: ProductVariantRow,
  locale: string = DEFAULT_LOCALE,
): Variant {
  const price: Money = {
    amount: row.priceAmount,
    currency: row.priceCurrency,
  };
  const compareAtPrice: Money | null =
    row.compareAtAmount !== null && row.compareAtAmount !== undefined
      ? { amount: row.compareAtAmount, currency: row.priceCurrency }
      : null;

  // Variant translations are optional — the "default variant" of a single-
  // variant product carries an empty JSONB. `resolveTranslations` returns
  // `{}` in that case; we surface `null` rather than `""` so the wire
  // shape's `title: string | null` keeps its meaning ("no display label").
  const resolved = resolveTranslations<"title">(row.translations, locale);
  const title = resolved.title;

  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    title: title && title.length > 0 ? title : null,
    price,
    compareAtPrice,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function toProduct(
  row: ProductRow,
  variants: ProductVariantRow[],
  categoryIds: string[],
  locale: string = DEFAULT_LOCALE,
): Product {
  const resolved = resolveTranslations<"title" | "description">(
    row.translations,
    locale,
  );
  // Description is optional — when absent across all locales the resolver
  // returns `""`. Surface that as `null` so the wire shape distinguishes
  // "no description set" from "empty description".
  const description = resolved.description;
  return {
    id: row.id,
    slug: row.slug,
    title: resolved.title ?? "",
    description: description && description.length > 0 ? description : null,
    status: row.status as ProductStatus,
    defaultCurrency: row.defaultCurrency,
    imageUrl: row.imageUrl ?? null,
    imageAlt: row.imageAlt ?? null,
    categoryIds,
    variants: variants.map((v) => toVariant(v, locale)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function toInventoryLevel(row: InventoryLevelRow): InventoryLevel {
  return {
    id: row.id,
    variantId: row.variantId,
    locationId: row.locationId ?? null,
    available: row.available,
    reserved: row.reserved,
    updatedAt: row.updatedAt,
  };
}

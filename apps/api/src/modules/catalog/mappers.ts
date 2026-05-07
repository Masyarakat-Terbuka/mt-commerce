/**
 * Drizzle row → domain type mappers.
 *
 * The two-column `(price_amount, price_currency)` storage shape is collapsed
 * into a `Money` object so the rest of the system never deals with raw
 * bigints. The mapping is total — every column has a 1:1 destination.
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
import type {
  Category,
  InventoryLevel,
  Product,
  ProductStatus,
  Variant,
} from "./types.js";

export function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    parentId: row.parentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVariant(row: ProductVariantRow): Variant {
  const price: Money = {
    amount: row.priceAmount,
    currency: row.priceCurrency,
  };
  const compareAtPrice: Money | null =
    row.compareAtAmount !== null && row.compareAtAmount !== undefined
      ? { amount: row.compareAtAmount, currency: row.priceCurrency }
      : null;

  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    title: row.title ?? null,
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
): Product {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? null,
    status: row.status as ProductStatus,
    defaultCurrency: row.defaultCurrency,
    categoryIds,
    variants: variants.map((v) => toVariant(v)),
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

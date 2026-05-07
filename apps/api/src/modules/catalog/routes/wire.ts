/**
 * Wire-shape helpers — convert domain types to JSON-safe payloads.
 *
 * Why a separate layer:
 *   - The domain types (Product, Variant, ...) carry `Money` values with
 *     `bigint` amounts and `Date` instances. ADR-0007 says money on the
 *     wire is a string for precision; JSON itself uses ISO 8601 for dates.
 *   - The global `BigInt.prototype.toJSON` shim installed in `app.ts`
 *     would cover the bigint case too, but explicit conversion at this
 *     boundary makes the wire shape a typed contract instead of a side
 *     effect. Tests can assert on a known shape, and clients that read
 *     OpenAPI later will see the same model these helpers produce.
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Category,
  InventoryLevel,
  Product,
  ProductStatus,
  Variant,
} from "../types.js";

export interface WireProduct {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  defaultCurrency: string;
  /** Primary product image URL or null. */
  imageUrl: string | null;
  /** Alt text for `imageUrl`, or null. */
  imageAlt: string | null;
  categoryIds: string[];
  variants: WireVariant[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireVariant {
  id: string;
  productId: string;
  sku: string;
  title: string | null;
  price: MoneyJSON;
  compareAtPrice: MoneyJSON | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireCategory {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireInventoryLevel {
  id: string;
  variantId: string;
  locationId: string | null;
  available: number;
  reserved: number;
  updatedAt: string;
}

export function toWireVariant(variant: Variant): WireVariant {
  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    title: variant.title,
    price: moneyToJSON(variant.price),
    compareAtPrice: variant.compareAtPrice
      ? moneyToJSON(variant.compareAtPrice)
      : null,
    createdAt: variant.createdAt.toISOString(),
    updatedAt: variant.updatedAt.toISOString(),
    deletedAt: variant.deletedAt ? variant.deletedAt.toISOString() : null,
  };
}

export function toWireProduct(product: Product): WireProduct {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    description: product.description,
    status: product.status,
    defaultCurrency: product.defaultCurrency,
    imageUrl: product.imageUrl,
    imageAlt: product.imageAlt,
    categoryIds: product.categoryIds,
    variants: product.variants.map((v) => toWireVariant(v)),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    deletedAt: product.deletedAt ? product.deletedAt.toISOString() : null,
  };
}

export function toWireCategory(category: Category): WireCategory {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    parentId: category.parentId,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function toWireInventoryLevel(level: InventoryLevel): WireInventoryLevel {
  return {
    id: level.id,
    variantId: level.variantId,
    locationId: level.locationId,
    available: level.available,
    reserved: level.reserved,
    updatedAt: level.updatedAt.toISOString(),
  };
}

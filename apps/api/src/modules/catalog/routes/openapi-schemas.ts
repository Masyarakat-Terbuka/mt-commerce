/**
 * Shared OpenAPI wire-shape schemas for the catalog routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reference the same JSON
 * shape for products/variants/categories, so we register the OpenAPI
 * components in one place and import the schema from both routers. This
 * avoids the same component name (e.g. `Product`) being registered twice
 * with two near-identical schemas in the generated document.
 *
 * Runtime serialization still goes through `toWireProduct`/`toWireVariant`
 * in `wire.ts`; these are the spec-side mirror of the same shape per
 * ADR-0007 (money) and ADR-0010 (translations resolved to flat strings).
 */
import { z } from "@hono/zod-openapi";
import { MoneyJson, paginated } from "../../../lib/openapi-shared.js";

export const Money = MoneyJson;

export const VariantWire = z
  .object({
    id: z.string(),
    productId: z.string(),
    sku: z.string(),
    title: z.string().nullable(),
    price: Money,
    compareAtPrice: Money.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .openapi("Variant");

export const ProductWire = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(["draft", "active", "archived"]),
    defaultCurrency: z.string(),
    imageUrl: z.string().nullable(),
    imageAlt: z.string().nullable(),
    categoryIds: z.array(z.string()),
    variants: z.array(VariantWire),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .openapi("Product");

export const CategoryWire = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Category");

export const InventoryLevelWire = z
  .object({
    id: z.string(),
    variantId: z.string(),
    locationId: z.string().nullable(),
    available: z.number().int(),
    reserved: z.number().int(),
    updatedAt: z.string(),
  })
  .openapi("InventoryLevel");

export const PaginatedProductWire = paginated(ProductWire).openapi("PaginatedProduct");

export const CategoryListEnvelope = z
  .object({ data: z.array(CategoryWire) })
  .openapi("CategoryList");

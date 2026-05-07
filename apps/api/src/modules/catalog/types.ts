/**
 * Catalog domain types and Zod schemas.
 *
 * Two layers live in this file:
 *
 *   1. Domain types (Product, Variant, Category, InventoryLevel) — clean
 *      shapes the rest of the system consumes. Money is a `Money` value
 *      object, never a raw bigint+currency tuple. Dates are `Date`
 *      instances; the route layer converts to ISO strings on the way out.
 *
 *   2. Zod schemas for input validation at the HTTP boundary. They are the
 *      source of truth for request shape and surface through the standard
 *      validation_error response.
 *
 * Everything below is exported through `index.ts` so other modules and the
 * route handlers can import from a single, stable contract.
 */
import { z } from "zod";
import type { Money } from "@mt-commerce/core/money";

// ----------------------------------------------------------------------------
// Domain types
// ----------------------------------------------------------------------------

export type ProductStatus = "draft" | "active" | "archived";

export interface Product {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  defaultCurrency: string;
  categoryIds: string[];
  variants: Variant[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  title: string | null;
  price: Money;
  /** Optional crossed-out price for promotions; same currency as `price`. */
  compareAtPrice: Money | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryLevel {
  id: string;
  variantId: string;
  /** NULL for the v1 single-location store. */
  locationId: string | null;
  available: number;
  reserved: number;
  updatedAt: Date;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ----------------------------------------------------------------------------
// Zod schemas
// ----------------------------------------------------------------------------

/**
 * Slug rule: lowercase alphanumeric segments separated by single hyphens, 1-100
 * chars. Strict to keep URLs predictable and avoid encoding ambiguity.
 */
const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "slug must be lowercase, hyphen-separated alphanumerics",
  });

/** ISO 4217 currency code, three uppercase letters. Values like "IDR", "USD". */
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" });

const moneyAmountSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    try {
      // Reject NaN and non-finite numbers explicitly; the `BigInt()` ctor
      // throws for non-integer strings already.
      if (typeof value === "number") {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
          throw new Error("amount must be a whole-number value");
        }
        return BigInt(value);
      }
      if (!/^-?\d+$/.test(value)) {
        throw new Error("amount string must be a decimal integer");
      }
      return BigInt(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          err instanceof Error
            ? err.message
            : "amount must be a decimal integer (string or number)",
      });
      return z.NEVER;
    }
  });

export const productStatusSchema = z.enum(["draft", "active", "archived"]);

export const createProductSchema = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  status: productStatusSchema.optional(),
  defaultCurrency: currencySchema,
  categoryIds: z.array(z.string().min(1)).optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    slug: slugSchema.optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    status: productStatusSchema.optional(),
    defaultCurrency: currencySchema.optional(),
    categoryIds: z.array(z.string().min(1)).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const createVariantSchema = z.object({
  sku: z.string().min(1).max(100),
  title: z.string().min(1).max(200).nullable().optional(),
  priceAmount: moneyAmountSchema,
  /**
   * Optional. When omitted, the parent product's `defaultCurrency` is used.
   * The service rejects mismatched currencies between siblings to keep
   * cross-currency arithmetic out of carts and orders.
   */
  priceCurrency: currencySchema.optional(),
  compareAtAmount: moneyAmountSchema.optional(),
});
export type CreateVariantInput = z.infer<typeof createVariantSchema>;

export const updateVariantSchema = z
  .object({
    sku: z.string().min(1).max(100).optional(),
    title: z.string().min(1).max(200).nullable().optional(),
    priceAmount: moneyAmountSchema.optional(),
    priceCurrency: currencySchema.optional(),
    compareAtAmount: moneyAmountSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

export const createCategorySchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  parentId: z.string().min(1).nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    slug: slugSchema.optional(),
    name: z.string().min(1).max(200).optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const adjustInventorySchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, {
    message: "delta must be a non-zero integer",
  }),
});
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;

// ----------------------------------------------------------------------------
// List query
// ----------------------------------------------------------------------------

export const productSortSchema = z.enum([
  "newest",
  "oldest",
  "price_asc",
  "price_desc",
]);
export type ProductSort = z.infer<typeof productSortSchema>;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Storefront and admin list-query schema. `coerce` flips the URL-string-only
 * inputs into the right primitive types. We accept either `categoryId` (admin)
 * or `categorySlug` (storefront) — not both — so the storefront does not have
 * to know about IDs.
 */
export const listProductsQuerySchema = z.object({
  status: productStatusSchema.optional(),
  categoryId: z.string().min(1).optional(),
  categorySlug: slugSchema.optional(),
  search: z.string().min(1).max(200).optional(),
  minPriceAmount: moneyAmountSchema.optional(),
  maxPriceAmount: moneyAmountSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  sort: productSortSchema.default("newest"),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/**
 * Catalog domain types and Zod schemas.
 *
 * Two layers live in this file:
 *
 *   1. Domain types (Product, Variant, Category, InventoryLevel) — clean
 *      shapes the rest of the system consumes. Money is a `Money` value
 *      object, never a raw bigint+currency tuple. Dates are `Date`
 *      instances; the route layer converts to ISO strings on the way out.
 *      Translatable strings (`title`, `description`, `name`) are exposed as
 *      flat strings here — the JSONB `translations` column is resolved by
 *      the mapper layer per ADR-0010, and the rest of the system never
 *      sees the locale-keyed shape.
 *
 *   2. Zod schemas for input validation at the HTTP boundary. They are the
 *      source of truth for request shape and surface through the standard
 *      validation_error response. Translatable inputs accept the full
 *      `translations` object (locale → field map) and require at least the
 *      default locale (`id`) to be present so a write that omits Bahasa is
 *      caught at the boundary rather than producing a silent gap.
 *
 * Everything below is exported through `index.ts` so other modules and the
 * route handlers can import from a single, stable contract.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES, type Money } from "@mt-commerce/core/money";
import { DEFAULT_LOCALE, KNOWN_LOCALES } from "./i18n.js";
import type {
  CategoryTranslations,
  ProductTranslations,
  VariantTranslations,
} from "../../db/schema/index.js";

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
  /**
   * Primary product image URL. Null when the product has no image yet —
   * the storefront falls back to a neutral placeholder so the layout
   * never collapses.
   */
  imageUrl: string | null;
  /** Alt text for `imageUrl`. Null when no image is set. */
  imageAlt: string | null;
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

/**
 * ISO 4217 currency code restricted to the set mt-commerce supports as
 * first-class (see `KNOWN_CURRENCIES` in `@mt-commerce/core/money`). A naive
 * `^[A-Z]{3}$` regex would happily accept e.g. "XXX" or "ZZZ", which then
 * silently flows through pricing and formatting and only surfaces as an
 * `Intl.NumberFormat` runtime error at the storefront. Validating against
 * the known list at the boundary fails fast with a clear message.
 */
const knownCurrencySet = new Set<string>(KNOWN_CURRENCIES);
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" })
  .refine((code) => knownCurrencySet.has(code), {
    message: `currency must be one of: ${[...KNOWN_CURRENCIES].sort().join(", ")}`,
  });

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

/**
 * Image URL constraints. Cap the length to keep accidental data-URLs out
 * (a base64 PNG can run into the megabytes; the column is for short URLs).
 * URL validity is enforced separately so the message is precise on bad
 * input rather than dumping a Zod union error.
 */
const imageUrlSchema = z.string().min(1).max(2048).url({
  message: "imageUrl must be a valid http(s) URL",
});

const imageAltSchema = z.string().min(1).max(500);

// ----------------------------------------------------------------------------
// Translation-input schemas
// ----------------------------------------------------------------------------

/**
 * Locale code: a member of `KNOWN_LOCALES` (`"id"`, `"en"`). Unknown locales
 * are rejected at the boundary on writes — silent coercion is the right
 * behavior for read-side `?locale=` (see `routes/locale.ts`), but a write
 * that targets an unknown locale would land translations the resolver can
 * never expose.
 */
const localeSchema = z.enum(KNOWN_LOCALES);

const KNOWN_LOCALES_LABEL = KNOWN_LOCALES.join(", ");

/**
 * Build a Zod schema for the `translations` JSONB column. The shape is
 * `{ <locale>: { <field>: string } }`. The default locale (`id`) is required
 * on create; on update we only validate that whatever locales *are* present
 * carry strings — the merchant should be free to add `en` without re-asserting
 * `id` every time.
 *
 * Field-level constraints (max length per field) are applied per call so that
 * `description` can allow a longer body than `title`.
 */
function buildTranslationsSchema<F extends string>(
  fields: ReadonlyArray<{
    name: F;
    max: number;
    /** When true, the field must be present under the default locale. */
    requiredOnDefault: boolean;
  }>,
  options: { requireDefaultLocale: boolean },
) {
  const localeBlobShape = Object.fromEntries(
    fields.map((f) => [f.name, z.string().min(1).max(f.max)]),
  ) as Record<F, z.ZodString>;

  // Each locale's payload: every field optional at the schema level, with
  // the "required on default" enforcement applied below. We need fields to
  // be optional at this layer because non-default locales may carry only a
  // subset of the fields (e.g. `en` ships `title` first, `description` later).
  const localeBlobSchema = z
    .object(
      Object.fromEntries(
        fields.map((f) => [f.name, localeBlobShape[f.name].optional()]),
      ) as Record<F, z.ZodOptional<z.ZodString>>,
    )
    .strict();

  // `record(localeSchema, blobSchema)` would be cleaner, but z.record's
  // typing collapses to `Partial` here and would not round-trip the
  // `Translations<F>` type below. Building the object manually keeps the
  // type precise.
  return z
    .record(z.string(), localeBlobSchema)
    .superRefine((value, ctx) => {
      // Reject locales not in KNOWN_LOCALES. Silent coercion on the read
      // path is desirable — but on write, an unknown locale would store
      // bytes the resolver can never surface, so we surface a clear error.
      for (const localeKey of Object.keys(value)) {
        if (!(KNOWN_LOCALES as readonly string[]).includes(localeKey)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [localeKey],
            message: `unknown locale "${localeKey}"; allowed: ${KNOWN_LOCALES_LABEL}`,
          });
        }
      }

      if (options.requireDefaultLocale) {
        const defaultBlob = value[DEFAULT_LOCALE];
        if (!defaultBlob) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [DEFAULT_LOCALE],
            message: `translations must include the default locale "${DEFAULT_LOCALE}"`,
          });
          return;
        }
        for (const f of fields) {
          if (f.requiredOnDefault) {
            const v = defaultBlob[f.name];
            if (typeof v !== "string" || v.length === 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [DEFAULT_LOCALE, f.name],
                message: `translations.${DEFAULT_LOCALE}.${f.name} is required`,
              });
            }
          }
        }
      }
    })
    .transform((value) => value as Record<string, Partial<Record<F, string>>>);
}

/**
 * Reject the legacy flat-string shape (`title: "..."`, `description: "..."`,
 * `name: "..."`). The migration to JSONB happened in 0007; callers that
 * still send the flat shape are using a pre-translation client.
 *
 * We surface a single, clear validation error pointing at the offending
 * field so the caller knows exactly what changed.
 */
function rejectLegacyFlatField(
  raw: unknown,
  field: string,
): z.ZodIssue | null {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    field in (raw as Record<string, unknown>)
  ) {
    return {
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `legacy "${field}" field is no longer accepted; use "translations.${DEFAULT_LOCALE}.${field}" (see ADR-0010)`,
    };
  }
  return null;
}

const productTranslationsCreateSchema = buildTranslationsSchema<
  "title" | "description"
>(
  [
    { name: "title", max: 200, requiredOnDefault: true },
    { name: "description", max: 10_000, requiredOnDefault: false },
  ],
  { requireDefaultLocale: true },
);

const productTranslationsUpdateSchema = buildTranslationsSchema<
  "title" | "description"
>(
  [
    { name: "title", max: 200, requiredOnDefault: true },
    { name: "description", max: 10_000, requiredOnDefault: false },
  ],
  { requireDefaultLocale: false },
);

const variantTranslationsCreateSchema = buildTranslationsSchema<"title">(
  [{ name: "title", max: 200, requiredOnDefault: true }],
  { requireDefaultLocale: false },
);

const variantTranslationsUpdateSchema = buildTranslationsSchema<"title">(
  [{ name: "title", max: 200, requiredOnDefault: true }],
  { requireDefaultLocale: false },
);

const categoryTranslationsCreateSchema = buildTranslationsSchema<"name">(
  [{ name: "name", max: 200, requiredOnDefault: true }],
  { requireDefaultLocale: true },
);

const categoryTranslationsUpdateSchema = buildTranslationsSchema<"name">(
  [{ name: "name", max: 200, requiredOnDefault: true }],
  { requireDefaultLocale: false },
);

// ----------------------------------------------------------------------------
// Product / variant / category schemas
// ----------------------------------------------------------------------------

export const createProductSchema = z
  .object({
    slug: slugSchema,
    translations: productTranslationsCreateSchema,
    status: productStatusSchema.optional(),
    defaultCurrency: currencySchema,
    imageUrl: imageUrlSchema.nullable().optional(),
    imageAlt: imageAltSchema.nullable().optional(),
    categoryIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    for (const legacy of ["title", "description"]) {
      const issue = rejectLegacyFlatField(value as unknown, legacy);
      if (issue) ctx.addIssue(issue);
    }
  });
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    slug: slugSchema.optional(),
    translations: productTranslationsUpdateSchema.optional(),
    status: productStatusSchema.optional(),
    defaultCurrency: currencySchema.optional(),
    imageUrl: imageUrlSchema.nullable().optional(),
    imageAlt: imageAltSchema.nullable().optional(),
    categoryIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    for (const legacy of ["title", "description"]) {
      const issue = rejectLegacyFlatField(value as unknown, legacy);
      if (issue) ctx.addIssue(issue);
    }
  })
  .refine(
    (patch) => {
      // Strip the legacy fields the superRefine flagged so the "at least one
      // field" rule below stays meaningful when the only thing the caller
      // sent was a legacy `title`.
      const allowed = [
        "slug",
        "translations",
        "status",
        "defaultCurrency",
        "imageUrl",
        "imageAlt",
        "categoryIds",
      ];
      return allowed.some((k) => k in (patch as Record<string, unknown>));
    },
    { message: "patch must include at least one field" },
  );
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const createVariantSchema = z
  .object({
    sku: z.string().min(1).max(100),
    /**
     * Optional. Variants without a `translations` blob (or with an empty
     * one) are the "default variant" of a single-variant product — the
     * storefront falls back to the parent product's title. See ADR-0010.
     */
    translations: variantTranslationsCreateSchema.optional(),
    priceAmount: moneyAmountSchema,
    /**
     * Optional. When omitted, the parent product's `defaultCurrency` is used.
     * The service rejects mismatched currencies between siblings to keep
     * cross-currency arithmetic out of carts and orders.
     */
    priceCurrency: currencySchema.optional(),
    compareAtAmount: moneyAmountSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const issue = rejectLegacyFlatField(value as unknown, "title");
    if (issue) ctx.addIssue(issue);
  });
export type CreateVariantInput = z.infer<typeof createVariantSchema>;

export const updateVariantSchema = z
  .object({
    sku: z.string().min(1).max(100).optional(),
    translations: variantTranslationsUpdateSchema.optional(),
    priceAmount: moneyAmountSchema.optional(),
    priceCurrency: currencySchema.optional(),
    compareAtAmount: moneyAmountSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = rejectLegacyFlatField(value as unknown, "title");
    if (issue) ctx.addIssue(issue);
  })
  .refine(
    (patch) => {
      const allowed = [
        "sku",
        "translations",
        "priceAmount",
        "priceCurrency",
        "compareAtAmount",
      ];
      return allowed.some((k) => k in (patch as Record<string, unknown>));
    },
    { message: "patch must include at least one field" },
  );
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;

export const createCategorySchema = z
  .object({
    slug: slugSchema,
    translations: categoryTranslationsCreateSchema,
    parentId: z.string().min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = rejectLegacyFlatField(value as unknown, "name");
    if (issue) ctx.addIssue(issue);
  });
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    slug: slugSchema.optional(),
    translations: categoryTranslationsUpdateSchema.optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = rejectLegacyFlatField(value as unknown, "name");
    if (issue) ctx.addIssue(issue);
  })
  .refine(
    (patch) => {
      const allowed = ["slug", "translations", "parentId"];
      return allowed.some((k) => k in (patch as Record<string, unknown>));
    },
    { message: "patch must include at least one field" },
  );
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// Re-export the schema-level translation types so callers (service, mappers)
// have a single source of truth.
export type { CategoryTranslations, ProductTranslations, VariantTranslations };

// ----------------------------------------------------------------------------
// Inventory
// ----------------------------------------------------------------------------

/**
 * Inventory adjustments are bounded to ±1,000,000 to keep the value safely
 * inside Postgres `int4` (max ~2.1B) even when added to a large existing
 * `available`. Real-world adjustments are receipts/sales/audits, which fit
 * comfortably; bulk loads should paginate. Without these bounds an oversized
 * `delta` overflowed `int4` and surfaced as a Postgres `22003` error mapped
 * to a 500 — a validation failure leaking as a server error.
 */
const INVENTORY_DELTA_LIMIT = 1_000_000;

export const adjustInventorySchema = z.object({
  delta: z
    .number()
    .int({ message: "delta must be an integer" })
    .min(-INVENTORY_DELTA_LIMIT, {
      message: `delta must be between -${INVENTORY_DELTA_LIMIT} and ${INVENTORY_DELTA_LIMIT}`,
    })
    .max(INVENTORY_DELTA_LIMIT, {
      message: `delta must be between -${INVENTORY_DELTA_LIMIT} and ${INVENTORY_DELTA_LIMIT}`,
    })
    .refine((n) => n !== 0, {
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
export const listProductsQuerySchema = z
  .object({
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
  })
  .refine(
    (q) => !(q.categoryId !== undefined && q.categorySlug !== undefined),
    {
      message: "Use either categoryId or categorySlug, not both.",
      path: ["categorySlug"],
    },
  );
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/**
 * `CatalogService` — the public contract other modules and HTTP routes use to
 * read and modify catalog data. Per ADR-0005, no module reaches into our
 * tables directly; everything goes through this surface.
 *
 * Concerns this layer owns:
 *   - input → row coercion (via the Zod-validated input types from `types.ts`)
 *   - row → domain mapping (delegated to `mappers.ts`)
 *   - cross-row composition (a Product needs its variants and categories)
 *   - validation that requires a lookup (slug uniqueness, variant currency
 *     against product default, soft-delete state for storefront reads)
 *   - locale resolution at the read boundary (per ADR-0010): every read
 *     accepts an optional `locale?: string`; the mapper flattens the JSONB
 *     `translations` column to plain `title`/`description`/`name` strings
 *     for that locale.
 *   - domain errors (NotFoundError, ConflictError, ValidationError) — never
 *     leaks Drizzle or Postgres errors through to callers
 *
 * The service is constructed with a repository so tests can swap a fake
 * repository in without touching the database.
 */
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import {
  createCatalogRepository,
  type CatalogRepository,
} from "./repository.js";
import { toCategory, toInventoryLevel, toProduct, toVariant } from "./mappers.js";
import { DEFAULT_LOCALE } from "./i18n.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CategoryTranslations,
  type Category,
  type CreateCategoryInput,
  type CreateProductInput,
  type CreateVariantInput,
  type InventoryLevel,
  type ListProductsQuery,
  type Paginated,
  type Product,
  type ProductTranslations,
  type UpdateCategoryInput,
  type UpdateProductInput,
  type UpdateVariantInput,
  type Variant,
  type VariantTranslations,
} from "./types.js";

export interface CatalogService {
  // Products
  createProduct(input: CreateProductInput, locale?: string): Promise<Product>;
  getProductById(id: string, locale?: string): Promise<Product | null>;
  /**
   * Look up by slug. `options.activeOnly` restricts to products with status
   * `active` and `deleted_at IS NULL`, which is what the storefront wants.
   * Admin callers omit the option (or pass `false`) to see drafts/archived.
   */
  getProductBySlug(
    slug: string,
    options?: { activeOnly?: boolean; locale?: string },
  ): Promise<Product | null>;
  listProducts(
    query: ListProductsQuery & { activeOnly?: boolean; locale?: string },
  ): Promise<Paginated<Product>>;
  updateProduct(
    id: string,
    patch: UpdateProductInput,
    locale?: string,
  ): Promise<Product>;
  softDeleteProduct(id: string): Promise<void>;

  // Variants
  createVariant(
    productId: string,
    input: CreateVariantInput,
    locale?: string,
  ): Promise<Variant>;
  updateVariant(
    id: string,
    patch: UpdateVariantInput,
    locale?: string,
  ): Promise<Variant>;
  softDeleteVariant(id: string): Promise<void>;

  // Categories
  listCategories(locale?: string): Promise<Category[]>;
  createCategory(
    input: CreateCategoryInput,
    locale?: string,
  ): Promise<Category>;
  updateCategory(
    id: string,
    patch: UpdateCategoryInput,
    locale?: string,
  ): Promise<Category>;
  deleteCategory(id: string): Promise<void>;

  // Inventory
  getInventory(variantId: string): Promise<InventoryLevel | null>;
  adjustInventory(variantId: string, delta: number): Promise<InventoryLevel>;
}

export class CatalogServiceImpl implements CatalogService {
  constructor(private readonly repo: CatalogRepository) {}

  // -------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------

  async createProduct(
    input: CreateProductInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Product> {
    if (await this.repo.getProductBySlug(input.slug)) {
      throw new ConflictError("A product with this slug already exists.", {
        slug: input.slug,
      });
    }

    const productId = id("prod");
    const row = await this.repo.insertProduct({
      id: productId,
      slug: input.slug,
      translations: input.translations as ProductTranslations,
      status: input.status ?? "draft",
      defaultCurrency: input.defaultCurrency,
      imageUrl: input.imageUrl ?? null,
      imageAlt: input.imageAlt ?? null,
    });

    if (input.categoryIds && input.categoryIds.length > 0) {
      await this.repo.setProductCategories(productId, input.categoryIds);
    }

    return toProduct(row, [], input.categoryIds ?? [], locale);
  }

  async getProductById(
    productId: string,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Product | null> {
    const row = await this.repo.getProductById(productId);
    if (!row) return null;
    return this.composeProduct(row, locale);
  }

  async getProductBySlug(
    slug: string,
    options?: { activeOnly?: boolean; locale?: string },
  ): Promise<Product | null> {
    const row = await this.repo.getProductBySlug(slug);
    if (!row) return null;
    if (options?.activeOnly) {
      // Storefront context: hide drafts, archived, and soft-deleted products.
      if (row.status !== "active" || row.deletedAt !== null) return null;
    }
    return this.composeProduct(row, options?.locale ?? DEFAULT_LOCALE);
  }

  async listProducts(
    query: ListProductsQuery & { activeOnly?: boolean; locale?: string },
  ): Promise<Paginated<Product>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const locale = query.locale ?? DEFAULT_LOCALE;

    const { rows, total } = await this.repo.listProducts({
      ...(query.activeOnly ? { status: "active", excludeDeleted: true } : {
        ...(query.status ? { status: query.status } : {}),
      }),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.categorySlug ? { categorySlug: query.categorySlug } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.minPriceAmount !== undefined
        ? { minPriceAmount: query.minPriceAmount }
        : {}),
      ...(query.maxPriceAmount !== undefined
        ? { maxPriceAmount: query.maxPriceAmount }
        : {}),
      page,
      pageSize,
      sort: query.sort,
      // The repository's search ILIKE runs against the resolved-locale title;
      // forward the locale so a search in `?locale=en` matches English titles
      // rather than the default's.
      locale: locale === "en" ? "en" : "id",
    });

    const productIds = rows.map((row) => row.id);
    const [variants, categoryMap] = await Promise.all([
      this.repo.listVariantsForProducts(productIds),
      this.repo.listCategoryIdsForProducts(productIds),
    ]);
    const variantsByProduct = groupBy(variants, (v) => v.productId);

    const data = rows.map((row) =>
      toProduct(
        row,
        variantsByProduct.get(row.id) ?? [],
        categoryMap.get(row.id) ?? [],
        locale,
      ),
    );

    return { data, total, page, pageSize };
  }

  async updateProduct(
    productId: string,
    patch: UpdateProductInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Product> {
    const existing = await this.repo.getProductById(productId);
    if (!existing) {
      throw new NotFoundError("Product not found.", { productId });
    }

    if (patch.slug && patch.slug !== existing.slug) {
      const conflict = await this.repo.getProductBySlug(patch.slug);
      if (conflict && conflict.id !== productId) {
        throw new ConflictError("A product with this slug already exists.", {
          slug: patch.slug,
        });
      }
    }

    // Currency consistency: a product's `defaultCurrency` and its variants'
    // `priceCurrency` must agree. Changing the product currency while any
    // variant still prices in the old currency would silently introduce a
    // cross-currency product, which the rest of the domain forbids.
    //
    // We refuse rather than auto-rewriting variant currencies, because that
    // would amount to a silent bulk price change (Rp 250,000 is not USD
    // 250,000). The merchant must explicitly update each conflicting variant
    // first.
    if (
      patch.defaultCurrency !== undefined &&
      patch.defaultCurrency !== existing.defaultCurrency
    ) {
      const variants = await this.repo.listVariantsForProducts([productId]);
      const conflicts = variants.filter(
        (v) => v.priceCurrency !== patch.defaultCurrency,
      );
      if (conflicts.length > 0) {
        throw new ValidationError(
          "Cannot change defaultCurrency while variants price in a different currency. Update variant prices first.",
          {
            code: "currency_mismatch",
            requestedCurrency: patch.defaultCurrency,
            currentCurrency: existing.defaultCurrency,
            conflictingVariants: conflicts.map((v) => ({
              variantId: v.id,
              priceCurrency: v.priceCurrency,
            })),
          },
        );
      }
    }

    // Translation patches are a per-locale merge: keep prior locales the
    // caller did not touch, replace each locale they did. The "patch a
    // single field within a locale" case (e.g. "fix only the en title") is
    // handled by the caller sending the full locale blob — the resolver
    // semantics make a partial write inside one locale ambiguous.
    const mergedTranslations: ProductTranslations | undefined =
      patch.translations !== undefined
        ? mergeTranslations<"title" | "description">(
            existing.translations,
            patch.translations as ProductTranslations,
          )
        : undefined;

    const updated = await this.repo.updateProduct(productId, {
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(mergedTranslations !== undefined
        ? { translations: mergedTranslations }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.defaultCurrency !== undefined
        ? { defaultCurrency: patch.defaultCurrency }
        : {}),
      ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
      ...(patch.imageAlt !== undefined ? { imageAlt: patch.imageAlt } : {}),
    });
    if (!updated) {
      throw new NotFoundError("Product not found.", { productId });
    }

    if (patch.categoryIds !== undefined) {
      await this.repo.setProductCategories(productId, patch.categoryIds);
    }

    return this.composeProduct(updated, locale);
  }

  async softDeleteProduct(productId: string): Promise<void> {
    const existing = await this.repo.getProductById(productId);
    if (!existing) {
      throw new NotFoundError("Product not found.", { productId });
    }
    await this.repo.softDeleteProduct(productId);
  }

  // -------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------

  async createVariant(
    productId: string,
    input: CreateVariantInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Variant> {
    const product = await this.repo.getProductById(productId);
    if (!product) {
      throw new NotFoundError("Product not found.", { productId });
    }

    // Currency precedence rule: explicit `priceCurrency` on the variant wins,
    // but it must match the product's `defaultCurrency`. Cross-currency
    // variants under one product are forbidden — a single product cannot have
    // a $10 variant and an Rp 150,000 variant; create two products instead.
    const variantCurrency = input.priceCurrency ?? product.defaultCurrency;
    if (variantCurrency !== product.defaultCurrency) {
      throw new ValidationError(
        "Variant currency must match the product's default currency.",
        { variantCurrency, productCurrency: product.defaultCurrency },
      );
    }

    const variantId = id("var");
    const row = await this.repo.insertVariant({
      id: variantId,
      productId,
      sku: input.sku,
      translations: (input.translations ?? {}) as VariantTranslations,
      priceAmount: input.priceAmount,
      priceCurrency: variantCurrency,
      ...(input.compareAtAmount !== undefined
        ? { compareAtAmount: input.compareAtAmount }
        : {}),
    });

    // Initialize an inventory level so adjustInventory() does not have to
    // create on first write.
    await this.repo.insertInventoryLevel({
      id: id("inv"),
      variantId,
      locationId: null,
      available: 0,
      reserved: 0,
    });

    return toVariant(row, locale);
  }

  async updateVariant(
    variantId: string,
    patch: UpdateVariantInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Variant> {
    const existing = await this.repo.getVariantById(variantId);
    if (!existing) {
      throw new NotFoundError("Variant not found.", { variantId });
    }

    // Currency change must respect the parent product's default currency.
    if (patch.priceCurrency && patch.priceCurrency !== existing.priceCurrency) {
      const product = await this.repo.getProductById(existing.productId);
      if (!product) {
        throw new NotFoundError("Product not found.", {
          productId: existing.productId,
        });
      }
      if (patch.priceCurrency !== product.defaultCurrency) {
        throw new ValidationError(
          "Variant currency must match the product's default currency.",
          {
            variantCurrency: patch.priceCurrency,
            productCurrency: product.defaultCurrency,
          },
        );
      }
    }

    const mergedTranslations: VariantTranslations | undefined =
      patch.translations !== undefined
        ? mergeTranslations<"title">(
            existing.translations,
            patch.translations as VariantTranslations,
          )
        : undefined;

    const updated = await this.repo.updateVariant(variantId, {
      ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
      ...(mergedTranslations !== undefined
        ? { translations: mergedTranslations }
        : {}),
      ...(patch.priceAmount !== undefined
        ? { priceAmount: patch.priceAmount }
        : {}),
      ...(patch.priceCurrency !== undefined
        ? { priceCurrency: patch.priceCurrency }
        : {}),
      ...(patch.compareAtAmount !== undefined
        ? { compareAtAmount: patch.compareAtAmount }
        : {}),
    });
    if (!updated) {
      throw new NotFoundError("Variant not found.", { variantId });
    }
    return toVariant(updated, locale);
  }

  async softDeleteVariant(variantId: string): Promise<void> {
    const existing = await this.repo.getVariantById(variantId);
    if (!existing) {
      throw new NotFoundError("Variant not found.", { variantId });
    }
    await this.repo.softDeleteVariant(variantId);
  }

  // -------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------

  async listCategories(locale: string = DEFAULT_LOCALE): Promise<Category[]> {
    const rows = await this.repo.listCategories();
    return rows.map((row) => toCategory(row, locale));
  }

  async createCategory(
    input: CreateCategoryInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Category> {
    if (input.parentId) {
      const parent = await this.repo.getCategoryById(input.parentId);
      if (!parent) {
        throw new ValidationError("Parent category not found.", {
          parentId: input.parentId,
        });
      }
    }
    const categoryId = id("cat");
    const row = await this.repo.insertCategory({
      id: categoryId,
      slug: input.slug,
      translations: input.translations as CategoryTranslations,
      parentId: input.parentId ?? null,
    });
    return toCategory(row, locale);
  }

  async updateCategory(
    categoryId: string,
    patch: UpdateCategoryInput,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Category> {
    const existing = await this.repo.getCategoryById(categoryId);
    if (!existing) {
      throw new NotFoundError("Category not found.", { categoryId });
    }
    if (patch.parentId === categoryId) {
      throw new ValidationError("A category cannot be its own parent.");
    }
    const mergedTranslations: CategoryTranslations | undefined =
      patch.translations !== undefined
        ? mergeTranslations<"name">(
            existing.translations,
            patch.translations as CategoryTranslations,
          )
        : undefined;
    const updated = await this.repo.updateCategory(categoryId, {
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(mergedTranslations !== undefined
        ? { translations: mergedTranslations }
        : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
    });
    if (!updated) {
      throw new NotFoundError("Category not found.", { categoryId });
    }
    return toCategory(updated, locale);
  }

  async deleteCategory(categoryId: string): Promise<void> {
    const existing = await this.repo.getCategoryById(categoryId);
    if (!existing) {
      throw new NotFoundError("Category not found.", { categoryId });
    }
    await this.repo.deleteCategory(categoryId);
  }

  // -------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------

  async getInventory(variantId: string): Promise<InventoryLevel | null> {
    const row = await this.repo.getInventoryByVariant(variantId);
    return row ? toInventoryLevel(row) : null;
  }

  /**
   * TODO: wire to audit_log when it lands. The audit row should capture the
   * actor, the prior `available`, the delta, and the resulting `available`.
   */
  async adjustInventory(
    variantId: string,
    delta: number,
  ): Promise<InventoryLevel> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ValidationError("delta must be a non-zero integer.", { delta });
    }

    const existing = await this.repo.getInventoryByVariant(variantId);
    if (!existing) {
      throw new NotFoundError("Inventory level not found for variant.", {
        variantId,
      });
    }

    let updated: Awaited<ReturnType<CatalogRepository["adjustInventoryAtomic"]>>;
    try {
      updated = await this.repo.adjustInventoryAtomic(variantId, delta);
    } catch (err) {
      // Postgres `22003` (numeric_value_out_of_range) — the resulting
      // `available` would overflow `int4`. The Zod schema bounds `delta`
      // at the boundary, but a colossal pre-existing `available` plus a
      // legal-but-large delta could still overflow at the database. We
      // convert this single, well-understood case into a 400 here rather
      // than a generic 500 — and crucially do NOT add a wider catch.
      if (isPostgresErrorWithCode(err, "22003")) {
        throw new ValidationError(
          "Inventory adjustment would overflow the supported range.",
          {
            code: "out_of_range",
            variantId,
            delta,
            available: existing.available,
          },
        );
      }
      throw err;
    }
    if (!updated) {
      // The atomic update returned nothing, which means the WHERE guard
      // (`available + delta >= 0`) failed. Surface a clear conflict so the
      // caller can react (e.g. retry with a smaller delta).
      throw new ConflictError(
        "Inventory adjustment would drive `available` below zero.",
        { variantId, delta, available: existing.available },
      );
    }
    return toInventoryLevel(updated);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async composeProduct(
    row: ProductRowLike,
    locale: string,
  ): Promise<Product> {
    const [variants, categoryMap] = await Promise.all([
      this.repo.listVariantsForProducts([row.id]),
      this.repo.listCategoryIdsForProducts([row.id]),
    ]);
    return toProduct(row, variants, categoryMap.get(row.id) ?? [], locale);
  }
}

// Local alias so the private method does not import the schema row type.
type ProductRowLike = Parameters<typeof toProduct>[0];

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Per-locale merge for translation patches. The patch replaces each locale
 * blob the caller sent and leaves untouched locales alone — the unit of
 * change is "the locale," not "the field within the locale."
 *
 * Picking the per-locale grain (not per-field) keeps the resolver semantics
 * intact: a locale present in the JSONB always carries a complete-enough
 * blob to display, so a partial-field write cannot leave a half-translated
 * locale that confuses the fallback chain.
 */
function mergeTranslations<F extends string>(
  existing: Record<string, Partial<Record<F, string>>> | null | undefined,
  patch: Record<string, Partial<Record<F, string>>>,
): Record<string, Partial<Record<F, string>>> {
  const merged: Record<string, Partial<Record<F, string>>> = {
    ...(existing ?? {}),
  };
  for (const [locale, blob] of Object.entries(patch)) {
    merged[locale] = blob;
  }
  return merged;
}

/**
 * Narrow on the postgres-js (and node-postgres) `code` SQLSTATE field. We
 * read the field defensively because the error type is `unknown` once it
 * bubbles up from a catch block. Used only to reclassify a single
 * well-understood Postgres error in `adjustInventory`; intentionally not
 * exported and intentionally narrow.
 */
function isPostgresErrorWithCode(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = (err as { code?: unknown }).code;
  return candidate === code;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) {
      existing.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}

/**
 * Default singleton wired to the runtime database. Tests that want a fake
 * repository instantiate `CatalogServiceImpl` directly with the fake.
 */
export const catalogService: CatalogService = new CatalogServiceImpl(
  createCatalogRepository(),
);

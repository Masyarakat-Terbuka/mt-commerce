/**
 * The single boundary the storefront uses to talk to the API.
 *
 * Wraps `@mt-commerce/sdk` with two storefront-specific concerns:
 *
 *   1. Resilience — the storefront builds statically, and at build time the
 *      API may not be running. Every call here is wrapped in try/catch and
 *      returns an empty result on failure (the page renders the empty state
 *      rather than crashing). Errors are logged to the console so they are
 *      visible in development without leaking through to the visitor.
 *
 *   2. Shape adaptation — the SDK returns `Product` shapes typed by
 *      `@mt-commerce/sdk`. The existing storefront components (Price,
 *      ProductCard, Filters) consume a slightly older `mock-products`-style
 *      shape with localized title/description objects. We adapt at this
 *      boundary so the swap to real data was a localized change instead of a
 *      sweep through every page and component.
 *
 * The API base URL is read from `import.meta.env.PUBLIC_API_URL`. Astro
 * inlines `PUBLIC_*` env vars at build time for both server- and client-side
 * code, which is what the React product islands need to call the API on the
 * visitor's machine.
 */
import { createClient, type Product as SdkProduct, type MtCommerceClient } from "@mt-commerce/sdk";
import type { Money } from "@mt-commerce/core/money";
import type { Locale } from "./i18n.js";

export const DEFAULT_API_URL = "http://localhost:8000";

export function resolveApiUrl(): string {
  // Falls back to localhost so a developer who forgets to set the env var
  // still sees something useful in the dev server.
  const raw =
    typeof import.meta.env !== "undefined"
      ? (import.meta.env.PUBLIC_API_URL as string | undefined)
      : undefined;
  return raw && raw.length > 0 ? raw : DEFAULT_API_URL;
}

/**
 * Build an SDK client with `locale` baked in as the instance default. The
 * storefront has two locale shapes:
 *   - Short `Locale` (`"id" | "en"`) used for routing and the API.
 *   - BCP47 (`"id-ID"` / `"en-US"`) used by `Intl.NumberFormat` for prices.
 * The SDK only cares about the short form. Use this factory at every
 * server-rendered call site that needs locale-aware data.
 */
export function createStoreClient(locale: Locale): MtCommerceClient {
  return createClient({ baseUrl: resolveApiUrl(), locale });
}

/**
 * Map our short `Locale` to the BCP47 tag used for `Intl.NumberFormat`.
 * Centralized so islands and pages don't redo the mapping inline.
 */
export function toIntlLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "id-ID";
}

// ---------------------------------------------------------------------------
// Storefront-facing types — narrower and bilingual-safe.
// ---------------------------------------------------------------------------

export type SortKey = "newest" | "price_asc" | "price_desc";

export type StoreCategory = {
  id: string;
  slug: string;
  /**
   * The API returns a single category name (today, untranslated). The
   * storefront historically used `{ id, en }` per locale; we expose both
   * forms by mirroring the same string into both keys until the API grows
   * a translations field.
   */
  name: { id: string; en: string };
};

export type StoreVariant = {
  id: string;
  name: { id: string; en: string };
  price: Money;
  compareAt?: Money;
  available: boolean;
};

export type StoreProduct = {
  id: string;
  slug: string;
  title: { id: string; en: string };
  description: { id: string; en: string };
  /**
   * Always a non-empty string for `<img src>` purposes. Falls back to a
   * neutral placeholder when the API returns no image, so downstream
   * components do not need to branch.
   */
  imageUrl: string;
  /**
   * `true` when the product carries a real CDN image URL; `false` when
   * we have substituted a placeholder. Cards use this to render a
   * subtler "no photo yet" surface instead of a blurry placeholder.
   */
  hasImage: boolean;
  imageAlt: { id: string; en: string };
  categorySlug: string;
  variants: StoreVariant[];
  /** ISO 8601 — used for "newest" sort. */
  createdAt: string;
  /** Lowest variant price; convenience for cards and structured data. */
  basePrice: Money;
};

export type ListProductsQuery = {
  category?: string;
  search?: string;
  minPrice?: bigint;
  maxPrice?: bigint;
  sort?: SortKey;
  page?: number;
  pageSize?: number;
};

export type ListProductsResult = {
  items: StoreProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

const DEFAULT_PAGE_SIZE = 12;

// ---------------------------------------------------------------------------
// SDK → store-shape adapters.
// ---------------------------------------------------------------------------

/**
 * Compute the lowest-priced variant. Storefront cards display this as the
 * product's "from" price. Falls back to a zero amount if a product has no
 * variants — in practice the API filters those out for storefront reads,
 * but the fallback keeps the type non-nullable.
 */
function computeBasePrice(product: SdkProduct): Money {
  if (product.variants.length === 0) {
    return { amount: 0n, currency: product.defaultCurrency };
  }
  let lowest = product.variants[0]!.price;
  for (const v of product.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

/**
 * Empty 1x1 transparent placeholder used when a product has no image yet.
 * Inline data URL so the storefront stays useful even when the placeholder
 * CDN is unreachable. Cards detect this case via `hasImage: false` and
 * render a clean cream surface instead of an empty pixel.
 */
const TRANSPARENT_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%201%201%22%2F%3E";

function adaptProduct(product: SdkProduct): StoreProduct {
  const title = product.title;
  const description = product.description ?? "";
  const adaptedVariants: StoreVariant[] = product.variants.map((v) => ({
    id: v.id,
    name: { id: v.title ?? v.sku, en: v.title ?? v.sku },
    price: v.price,
    ...(v.compareAtPrice ? { compareAt: v.compareAtPrice } : {}),
    // The catalog API returns no inventory field on variants today.
    // Treat everything as available; replace once the SDK exposes inventory.
    available: true,
  }));

  // Image fields are nullable from the SDK. We surface a non-empty
  // `imageUrl` (real or transparent placeholder) plus a `hasImage` flag
  // so cards/detail pages can branch cleanly without re-checking nullity.
  // Alt text falls back to the title — better than an empty `alt`, which
  // would make the image invisible to screen readers.
  const imageUrl = product.imageUrl ?? TRANSPARENT_PLACEHOLDER;
  const hasImage = product.imageUrl !== null && product.imageUrl !== undefined;
  const altRaw = product.imageAlt ?? title;

  return {
    id: product.id,
    slug: product.slug,
    title: { id: title, en: title },
    description: { id: description, en: description },
    imageUrl,
    hasImage,
    imageAlt: { id: altRaw, en: altRaw },
    // The API exposes `categoryIds`; the storefront filters by slug. Use the
    // first category id as a slug-like identifier until the SDK joins the
    // category in the product payload. Empty string falls through to "no
    // matching category" which the filter handles cleanly.
    categorySlug: product.categoryIds[0] ?? "",
    variants: adaptedVariants,
    createdAt: product.createdAt.toISOString(),
    basePrice: computeBasePrice(product),
  };
}

// ---------------------------------------------------------------------------
// Public API — async, resilient.
// ---------------------------------------------------------------------------

export async function listCategories(locale: Locale): Promise<StoreCategory[]> {
  try {
    const cats = await createStoreClient(locale).storefront.categories.list();
    // The API returns a single locale-resolved `name`. The storefront's
    // historical shape mirrored both locales for consumers; we keep the
    // shape but populate both keys with the resolved string. Pages already
    // know their locale and pick `name[locale]`, so this is a no-op visible
    // to callers — and lets us delete the bilingual shape later without a
    // sweep through every page.
    return cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: { id: c.name, en: c.name },
    }));
  } catch (err) {
    console.error("[storefront] listCategories failed:", err);
    return [];
  }
}

export async function listProducts(
  locale: Locale,
  query: ListProductsQuery = {},
): Promise<ListProductsResult> {
  const {
    category,
    search,
    minPrice,
    maxPrice,
    sort = "newest",
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = query;

  try {
    const result = await createStoreClient(locale).storefront.products.list({
      ...(category ? { categorySlug: category } : {}),
      ...(search ? { search } : {}),
      ...(typeof minPrice === "bigint" ? { minPriceAmount: minPrice } : {}),
      ...(typeof maxPrice === "bigint" ? { maxPriceAmount: maxPrice } : {}),
      page,
      pageSize,
      sort,
    });
    const items = result.data.map(adaptProduct);
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    return {
      items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages,
    };
  } catch (err) {
    console.error("[storefront] listProducts failed:", err);
    return { items: [], total: 0, page: 1, pageSize, totalPages: 1 };
  }
}

export async function listFeaturedProducts(
  locale: Locale,
  limit = 4,
): Promise<StoreProduct[]> {
  const result = await listProducts(locale, { pageSize: limit, sort: "newest" });
  return result.items.slice(0, limit);
}

export async function getProductBySlug(
  locale: Locale,
  slug: string,
): Promise<StoreProduct | null> {
  try {
    const product = await createStoreClient(locale).storefront.products.bySlug(slug);
    return adaptProduct(product);
  } catch (err) {
    console.error(`[storefront] getProductBySlug(${slug}) failed:`, err);
    return null;
  }
}

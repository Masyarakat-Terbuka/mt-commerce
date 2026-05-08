/**
 * Curated collections registry.
 *
 * Why hardcoded TypeScript and not a CMS: PRODUCT.md rules out a
 * "general-purpose content management system" for v0.1. The home page
 * already drives its category strips off a hardcoded list of slugs;
 * collections follow the same pattern. When (and if) an editorial CMS
 * lands later, this file is the boundary that gets replaced — pages
 * import only `COLLECTIONS` and `getCollection`, so no further sweep
 * is needed at the call sites.
 *
 * Each entry materialises to a `listProducts(locale, query)` call on
 * the storefront listing page. Collections are NOT a separate API
 * surface — they are an editorial slice over the existing catalog.
 *
 * Adding a new collection:
 *   1. Append a `CollectionDef` here.
 *   2. Add `collections.<slug>.title` and `collections.<slug>.tagline`
 *      to `i18n/id.json` and `i18n/en.json`.
 *   3. The static routes pick it up automatically — no further edits.
 */
import type { ListProductsQuery } from "./api.js";

export interface CollectionDef {
  /** URL slug — `/collections/<slug>`. Lowercase, kebab-case. */
  slug: string;
  /**
   * i18n key for the collection's display title. Lives at
   * `collections.<slug>.title` in `id.json` and `en.json`.
   */
  titleKey: string;
  /**
   * i18n key for the collection's editorial tagline. Lives at
   * `collections.<slug>.tagline` in both dictionaries. One or two
   * sentences in the calm OSS tone PRODUCT.md asks for.
   */
  taglineKey: string;
  /**
   * The `listProducts` query this collection materialises. Treat
   * collections as filter presets over the existing catalog — anything
   * the listing page accepts is fair game here.
   */
  query: ListProductsQuery;
  /**
   * Override for grid page size on the collection landing page.
   * Defaults to 24 — fills 6 desktop rows of 4 cards each, which is
   * a generous-but-bounded landing without any pagination wiring.
   */
  pageSize?: number;
}

/**
 * The four v0.1 collections. Slugs are stable URLs; do not rename
 * without a redirect plan — they are linkable from the footer and
 * (eventually) editorial content.
 */
export const COLLECTIONS: readonly CollectionDef[] = [
  {
    slug: "terbaru",
    titleKey: "collections.terbaru.title",
    taglineKey: "collections.terbaru.tagline",
    query: { sort: "newest" },
  },
  {
    slug: "harga-terjangkau",
    titleKey: "collections.harga-terjangkau.title",
    taglineKey: "collections.harga-terjangkau.tagline",
    query: { sort: "price_asc" },
  },
  {
    slug: "kopi-pilihan",
    titleKey: "collections.kopi-pilihan.title",
    taglineKey: "collections.kopi-pilihan.tagline",
    query: { category: "kopi", sort: "newest" },
  },
  {
    slug: "batik-warisan",
    titleKey: "collections.batik-warisan.title",
    taglineKey: "collections.batik-warisan.tagline",
    query: { category: "batik", sort: "newest" },
  },
] as const;

/** Default page size when a collection does not specify one. */
export const DEFAULT_COLLECTION_PAGE_SIZE = 24;

/**
 * Look up a collection by slug. Returns `undefined` for unknown slugs;
 * callers (the dynamic route) should let `getStaticPaths` filter those
 * out before they reach this lookup.
 */
export function getCollection(slug: string): CollectionDef | undefined {
  return COLLECTIONS.find((c) => c.slug === slug);
}

/**
 * Effective page size for a collection — the override if set, otherwise
 * `DEFAULT_COLLECTION_PAGE_SIZE`. Pulled into a helper so the route
 * file and any future call site stay consistent.
 */
export function pageSizeFor(def: CollectionDef): number {
  return def.pageSize ?? DEFAULT_COLLECTION_PAGE_SIZE;
}

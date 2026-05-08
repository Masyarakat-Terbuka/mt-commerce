/**
 * ProductGrid — client island.
 *
 * Why a React island instead of pure Astro server-render: the storefront
 * builds with `output: "static"` and the API may not be running at build
 * time. The page's frontmatter does fetch eagerly when the API is up — that
 * data is forwarded as `initialData` and rendered synchronously, so the
 * happy-path visitor never sees a "Memuat produk…" flash. When the build
 * was offline (no API reachable) the page passes nothing and the island
 * falls back to fetching from the SDK on mount, preserving the original
 * progressive-hydration property.
 *
 * Invalidation rule for `initialData`:
 *
 *   `initialData` is the rendering of the URL query at *request time*. The
 *   island treats it as a one-shot seed — keyed by a hash of the query that
 *   produced it — and only refetches when the query (filters/sort/page)
 *   actually changes. A static URL therefore never triggers a redundant
 *   client fetch. Filter/sort/page changes drive the SDK call as before.
 *
 * Visual notes (post-redesign):
 *
 *   - Cards are borderless. The image's edge IS the card's edge. Title and
 *     price sit below the image in calm `t-body` weight 400 — the price is
 *     muted on cards because the photo and title carry the visual hierarchy.
 *
 *   - The grid runs 4 columns at desktop, 3 at tablet, 2 on mobile —
 *     Muji's denser browse rhythm. The horizontal gap tightens at lg
 *     (`gap-x-8`) so 4-up cards don't feel cramped while keeping vertical
 *     `gap-y-20` so rows still breathe.
 *
 *   - Loading state mirrors the live grid template: matching skeleton
 *     cells with very subtle pulse so the page reads as "settling in"
 *     rather than "broken".
 *
 *   - Error and empty states are calm single paragraphs in line with the
 *     catalog's overall copywriting tone — no icons, no "Try again" buttons.
 *
 *   - The card markup mirrors `components/ProductCard.astro` because Astro
 *     components cannot render inside React islands. They stay in sync via
 *     the shared utility classes (`t-body`, `price-figure`, etc.).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient } from "@mt-commerce/sdk";

export type ProductGridQuery = {
  categorySlug?: string;
  search?: string;
  minPriceAmount?: string;
  maxPriceAmount?: string;
  page?: number;
  pageSize?: number;
  sort?: "newest" | "price_asc" | "price_desc" | "oldest";
};

/**
 * Minimal product shape the grid needs to render. Mirrors
 * `StoreProductCard` from `lib/api.ts` exactly — the page passes the
 * shape verbatim via `toProductCardListing`. Kept locally typed
 * (rather than `import type { StoreProductCard }`) so the island stays
 * self-describing: every prop the renderer reads is right here, not
 * behind one more import hop.
 */
export type ProductGridItem = {
  id: string;
  slug: string;
  /**
   * Locale-resolved title. Pages on `/` use Indonesian and pages on
   * `/en/` use English — the call site picks `title[locale]` before
   * forwarding so the island doesn't need to know about locales.
   */
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  variants: Array<{
    price: Money;
    compareAtPrice?: Money | null;
  }>;
};

export type ProductGridInitialData = {
  items: ProductGridItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type ProductGridProps = {
  apiUrl: string;
  /** BCP 47 locale used for currency formatting (e.g. "id-ID", "en-US"). */
  locale: string;
  /**
   * Short locale tag (`"id" | "en"`) sent to the API so product titles and
   * descriptions come back already translated. Kept separate from `locale`
   * because BCP47 ("id-ID") and the API's short codes ("id") are different
   * shapes; conflating them was the bug we want to avoid.
   */
  apiLocale: string;
  /**
   * Path prefix for product detail links — `/products` for the default
   * locale, `/en/products` for English. The page builds this; the island
   * does not know about locale routing.
   */
  detailHrefBase: string;
  emptyLabel: string;
  errorLabel: string;
  /** Localized aria-label for the loading skeleton. */
  skeletonLabel: string;
  query?: ProductGridQuery;
  /** When set, slices the result to at most this many cards (home featured). */
  limit?: number;
  /**
   * Skeleton cell count to render while loading. Matches the eventual
   * card count so there's no layout shift. Defaults to `pageSize` or 9.
   */
  skeletonCount?: number;
  /**
   * When true, renders a "Showing N products" caption above the grid.
   * Off by default so the home page's featured grid stays unadorned;
   * the listing page sets it to true.
   */
  showCount?: boolean;
  /**
   * Template for the count caption with a `{count}` token, e.g.
   * "Menampilkan {count} produk". Required when `showCount` is true.
   */
  showingCountTemplate?: string;
  /**
   * Localized caption shown beneath the product title when an image
   * URL is missing. Currently unused — the redesign drops the caption
   * from card image fallbacks (see ProductCard.astro). Kept as a prop
   * to avoid churn in pages that already pass it.
   */
  photoComingSoonLabel?: string;
  /**
   * Optional request-time payload. When present, the island renders the
   * cards synchronously on first mount — no skeleton flash. Subsequent
   * query changes drive a client-side fetch as usual.
   *
   * When absent (e.g. an offline build where the build-time fetch
   * returned no rows), the island falls back to fetching on mount —
   * the original progressive-hydration behavior.
   */
  initialData?: ProductGridInitialData;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; products: ProductGridItem[] }
  | { status: "error" };

function lowestPrice(p: ProductGridItem): Money | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

/**
 * Stable string key for a query — used to detect when the URL state
 * has changed and a refetch is required, even though we have seeded data
 * from a previous request.
 */
function querySignature(
  query: ProductGridQuery | undefined,
  limit: number | undefined,
): string {
  if (!query) return `|${limit ?? ""}`;
  const parts = [
    query.categorySlug ?? "",
    query.search ?? "",
    query.minPriceAmount ?? "",
    query.maxPriceAmount ?? "",
    query.page ?? "",
    query.pageSize ?? "",
    query.sort ?? "",
    limit ?? "",
  ];
  return parts.join("|");
}

// 4 columns desktop (lg), 3 columns tablet (md), 2 columns mobile.
// Horizontal gap tightens at md/lg (`gap-x-8`) so the denser 4-up rhythm
// doesn't feel cramped; vertical gap stays generous (`gap-y-20`) so the
// rows breathe — the negative space between rows is what keeps this calm.
const GRID_CLASSES =
  "grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-3 md:gap-x-8 md:gap-y-16 lg:grid-cols-4 lg:gap-x-8 lg:gap-y-20";

export default function ProductGrid({
  apiUrl,
  locale,
  apiLocale,
  detailHrefBase,
  emptyLabel,
  errorLabel,
  skeletonLabel,
  query,
  limit,
  skeletonCount,
  showCount = false,
  showingCountTemplate,
  initialData,
}: ProductGridProps) {
  // The signature of the query that produced the seeded snapshot. While the
  // current query still matches it, the seed is fresh and we skip the fetch.
  const seededSignature = useMemo(
    () => (initialData ? querySignature(query, limit) : null),
    // initialData is a request-time prop and stays stable across re-renders
    // for a given page render — capture the signature once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Initial state: when the page handed us request-time data, render those
  // cards immediately. Otherwise fall back to the original "loading" state
  // and let the effect below fetch from the SDK (offline-build path).
  const [state, setState] = useState<LoadState>(() => {
    if (initialData) {
      const items = limit
        ? initialData.items.slice(0, limit)
        : initialData.items;
      return { status: "ready", products: items };
    }
    return { status: "loading" };
  });
  // Track image URLs that fail to load so we can fall back to a clean
  // cream tile. A broken Unsplash URL or hotlink-block would otherwise
  // show a torn-image icon.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(
    () => new Set(),
  );

  // Memoize once — the grid layout is fixed at 4 desktop / 3 tablet / 2
  // mobile across all product counts. Page-level call sites pick a
  // `pageSize` that fills rows cleanly (e.g. listing uses 8 or 12); the
  // grid itself stays agnostic.
  const gridClasses = useMemo(() => GRID_CLASSES, []);

  // Skip-the-first-fetch ref. When `initialData` was used to seed state,
  // the first effect run must not fire a network request — otherwise we
  // pay the same skeleton-flash cost we wanted to avoid. The ref clears
  // on subsequent runs so user-driven query changes still refetch.
  const skipNextFetchRef = useRef<boolean>(initialData != null);

  const currentSignature = querySignature(query, limit);

  useEffect(() => {
    // Honour the "we just seeded this" hint, but only when the query
    // signature still matches the seed. If the user navigated to a
    // different query (filters / page), bypass the skip.
    if (skipNextFetchRef.current && seededSignature === currentSignature) {
      skipNextFetchRef.current = false;
      return;
    }
    skipNextFetchRef.current = false;

    const controller = new AbortController();
    // Bake the API locale into the client so every call from this island
    // hits the right translation. The page passes `apiLocale` explicitly;
    // we do not rely on `Accept-Language` because the storefront serves
    // `/en/` from a static build and the visitor's browser language may
    // not match the URL prefix.
    const client = createClient({ baseUrl: apiUrl, locale: apiLocale });

    // While in-flight, show the skeleton. Two cases reach here:
    //   1. Offline-build fallback (no initialData) — we were already in
    //      "loading" state, this is a no-op visually.
    //   2. The user changed a filter/sort/page after a seeded render —
    //      flipping back to loading is the correct UX (the previous
    //      result no longer matches the current URL).
    setState({ status: "loading" });

    async function load() {
      try {
        const result = await client.storefront.products.list(
          {
            ...(query?.categorySlug
              ? { categorySlug: query.categorySlug }
              : {}),
            ...(query?.search ? { search: query.search } : {}),
            ...(query?.minPriceAmount
              ? { minPriceAmount: query.minPriceAmount }
              : {}),
            ...(query?.maxPriceAmount
              ? { maxPriceAmount: query.maxPriceAmount }
              : {}),
            ...(query?.page ? { page: query.page } : {}),
            ...(query?.pageSize ? { pageSize: query.pageSize } : {}),
            ...(query?.sort ? { sort: query.sort } : {}),
          },
          { signal: controller.signal },
        );
        const products: ProductGridItem[] = result.data.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          imageUrl: p.imageUrl,
          imageAlt: p.imageAlt,
          variants: p.variants.map((v) => ({
            price: v.price,
            compareAtPrice: v.compareAtPrice,
          })),
        }));
        const sliced = limit ? products.slice(0, limit) : products;
        setState({ status: "ready", products: sliced });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        if ((err as { code?: string } | null)?.code === "request_aborted")
          return;
        console.error("[storefront] ProductGrid fetch failed:", err);
        setState({ status: "error" });
      }
    }

    void load();
    return () => controller.abort();
    // We deliberately depend on the query signature rather than each individual
    // field — same effect, smaller deps array, and aligns with the seed-key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, apiLocale, currentSignature]);

  if (state.status === "loading") {
    const cells = Math.max(2, skeletonCount ?? limit ?? query?.pageSize ?? 9);
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={skeletonLabel}
        className={GRID_CLASSES}
      >
        {Array.from({ length: cells }).map((_, idx) => (
          <div key={idx}>
            <div className="skeleton aspect-square w-full"></div>
            <div className="mt-4 space-y-2">
              <div className="skeleton h-3 w-3/4"></div>
              <div className="skeleton h-3 w-1/4"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="t-body text-muted py-16">
        {errorLabel}
      </p>
    );
  }

  if (state.products.length === 0) {
    return <p className="t-body text-muted py-16">{emptyLabel}</p>;
  }

  // Visible-count caption. Reflects what's rendered (post-`limit` slice),
  // not the API's unfiltered total — that's what users see on the page.
  const visibleCount = state.products.length;
  const countLabel =
    showCount && showingCountTemplate
      ? showingCountTemplate.replace("{count}", String(visibleCount))
      : null;

  return (
    <>
      {countLabel && <p className="t-caption text-faint mb-6">{countLabel}</p>}
      <div className={gridClasses}>
        {state.products.map((p, idx) => {
          const price = lowestPrice(p);
          const compareAt = p.variants[0]?.compareAtPrice ?? null;
          // Eager-load the first four (one full row at desktop, lg+) so
          // the LCP isn't deferred. Lazy after. Mobile/tablet show fewer
          // cards above the fold but eager-loading a couple of extras is
          // cheap and avoids a flash if the user is on a wide screen.
          const loading = idx < 4 ? "eager" : "lazy";
          const altText = p.imageAlt ?? p.title;
          return (
            <a
              key={p.id}
              href={`${detailHrefBase}/${p.slug}`}
              className="group block"
            >
              <div className="bg-cream aspect-square w-full overflow-hidden">
                {p.imageUrl && !brokenImages.has(p.id) ? (
                  <img
                    src={p.imageUrl}
                    alt={altText}
                    loading={loading}
                    decoding="async"
                    onError={() => {
                      setBrokenImages((prev) => {
                        if (prev.has(p.id)) return prev;
                        const next = new Set(prev);
                        next.add(p.id);
                        return next;
                      });
                    }}
                    // Pairs with the matching name on the PDP hero so a
                    // click-through morphs the card image into the hero.
                    // Same pattern as `ProductCard.astro`; the React
                    // grid is what the home page and listing page use,
                    // so the wiring needs to live here too.
                    style={{ viewTransitionName: `pdp-image-${p.slug}` }}
                    className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-6 text-center">
                    <span className="t-body text-fg line-clamp-2">
                      {p.title}
                    </span>
                  </div>
                )}
              </div>
              <div className="mt-4 space-y-1">
                <h3 className="t-body text-fg group-hover:text-accent line-clamp-1 transition-colors duration-200">
                  {p.title}
                </h3>
                <div className="t-body flex items-baseline gap-2">
                  {price && (
                    <span className="price-figure text-muted">
                      {formatMoney(price, { locale })}
                    </span>
                  )}
                  {compareAt && (
                    <span className="price-figure text-faint line-through">
                      {formatMoney(compareAt, { locale })}
                    </span>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </>
  );
}

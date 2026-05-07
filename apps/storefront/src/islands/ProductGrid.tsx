/**
 * ProductGrid — client island.
 *
 * Why a React island instead of Astro server-render: the storefront builds
 * with `output: "static"` and the API may not be running at build time. The
 * static page renders a grid skeleton; this island fetches real data from
 * the API once it mounts in the browser.
 *
 * Visual notes (post-redesign):
 *
 *   - Cards are borderless. The image's edge IS the card's edge. Title and
 *     price sit below the image in calm `t-body` weight 400 — the price is
 *     muted on cards because the photo and title carry the visual hierarchy.
 *
 *   - The grid runs 3 columns at desktop with a massive gap (lg:gap-x-12,
 *     lg:gap-y-16) — Saturdays NYC's editorial spacing. Mobile drops to 2
 *     columns with a smaller but still generous gap.
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
import { useEffect, useMemo, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import { createClient, type Product as SdkProduct } from "@mt-commerce/sdk";

export type ProductGridQuery = {
  categorySlug?: string;
  search?: string;
  minPriceAmount?: string;
  maxPriceAmount?: string;
  page?: number;
  pageSize?: number;
  sort?: "newest" | "price_asc" | "price_desc" | "oldest";
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
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; products: SdkProduct[] }
  | { status: "error" };

function lowestPrice(p: SdkProduct): { amount: bigint; currency: string } | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

// 3 columns desktop, 2 columns mobile. Massive gap (12/16 desktop) — the
// negative space between cards is the design element here.
const GRID_CLASSES =
  "grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-3 md:gap-x-10 md:gap-y-16 lg:gap-x-12 lg:gap-y-20";

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
}: ProductGridProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Track image URLs that fail to load so we can fall back to a clean
  // cream tile. A broken Unsplash URL or hotlink-block would otherwise
  // show a torn-image icon.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());

  // Memoize once — the grid layout is consistent across product counts now
  // that the redesign locks columns at 3 desktop / 2 mobile. The previous
  // "compact mode" branch was needed because the layout was 4-up and
  // tended to leave orphan rows; 3-up tolerates any count gracefully.
  const gridClasses = useMemo(() => GRID_CLASSES, []);

  useEffect(() => {
    const controller = new AbortController();
    // Bake the API locale into the client so every call from this island
    // hits the right translation. The page passes `apiLocale` explicitly;
    // we do not rely on `Accept-Language` because the storefront serves
    // `/en/` from a static build and the visitor's browser language may
    // not match the URL prefix.
    const client = createClient({ baseUrl: apiUrl, locale: apiLocale });

    async function load() {
      try {
        const result = await client.storefront.products.list(
          {
            ...(query?.categorySlug ? { categorySlug: query.categorySlug } : {}),
            ...(query?.search ? { search: query.search } : {}),
            ...(query?.minPriceAmount ? { minPriceAmount: query.minPriceAmount } : {}),
            ...(query?.maxPriceAmount ? { maxPriceAmount: query.maxPriceAmount } : {}),
            ...(query?.page ? { page: query.page } : {}),
            ...(query?.pageSize ? { pageSize: query.pageSize } : {}),
            ...(query?.sort ? { sort: query.sort } : {}),
          },
          { signal: controller.signal },
        );
        const products = limit ? result.data.slice(0, limit) : result.data;
        setState({ status: "ready", products });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        if ((err as { code?: string } | null)?.code === "request_aborted") return;
        console.error("[storefront] ProductGrid fetch failed:", err);
        setState({ status: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, [
    apiUrl,
    apiLocale,
    limit,
    query?.categorySlug,
    query?.search,
    query?.minPriceAmount,
    query?.maxPriceAmount,
    query?.page,
    query?.pageSize,
    query?.sort,
  ]);

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
            <div className="aspect-square w-full skeleton"></div>
            <div className="mt-4 space-y-2">
              <div className="h-3 w-3/4 skeleton"></div>
              <div className="h-3 w-1/4 skeleton"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="py-16 t-body text-muted">
        {errorLabel}
      </p>
    );
  }

  if (state.products.length === 0) {
    return (
      <p className="py-16 t-body text-muted">
        {emptyLabel}
      </p>
    );
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
      {countLabel && (
        <p className="t-caption mb-6 text-faint">{countLabel}</p>
      )}
      <div className={gridClasses}>
        {state.products.map((p, idx) => {
          const price = lowestPrice(p);
          const compareAt = p.variants[0]?.compareAtPrice ?? null;
          // Eager-load the first three (one full row at desktop) so the
          // LCP isn't deferred. Lazy after.
          const loading = idx < 3 ? "eager" : "lazy";
          const altText = p.imageAlt ?? p.title;
          return (
            <a
              key={p.id}
              href={`${detailHrefBase}/${p.slug}`}
              className="group block"
            >
              <div className="aspect-square w-full overflow-hidden bg-cream">
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
                    className="h-full w-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-6 text-center">
                    <span className="t-body line-clamp-2 text-fg">
                      {p.title}
                    </span>
                  </div>
                )}
              </div>
              <div className="mt-4 space-y-1">
                <h3 className="t-body line-clamp-1 text-fg transition-colors duration-200 group-hover:text-accent">
                  {p.title}
                </h3>
                <div className="flex items-baseline gap-2 t-body">
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

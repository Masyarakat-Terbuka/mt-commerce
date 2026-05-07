/**
 * ProductGrid — client island.
 *
 * Why this is a React island instead of an Astro server-render: the
 * storefront builds with `output: "static"` and the API is not
 * necessarily running at build time. To keep `bun run build`
 * deterministic and offline-friendly, the static page renders a grid
 * skeleton and this island fetches real data from the API once it
 * mounts in the browser.
 *
 * Visual notes:
 *
 *   - The card markup mirrors `components/ProductCard.astro` because
 *     Astro components cannot render inside React islands. Both stay
 *     in sync via the shared utility classes (`t-body`, `price-figure`,
 *     `border-line`, etc.) defined in `styles/global.css`.
 *
 *   - Loading state is a 4-column skeleton grid (2 columns on mobile)
 *     that matches the live grid template — no layout shift when data
 *     arrives. Each cell is the same 1:1 aspect placeholder + two
 *     stubby title/price bars.
 *
 *   - Error and empty states are calm single paragraphs in line with
 *     the catalog's overall copywriting tone.
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
  /** BCP 47 locale used for currency formatting. */
  locale: string;
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
   * card count so there's no layout shift. Defaults to `pageSize` or 8.
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
   * URL is missing or fails to load (e.g. "Foto segera hadir").
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

const GRID_CLASSES =
  "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-3 md:gap-x-6 md:gap-y-12 lg:grid-cols-4 lg:gap-x-8";

export default function ProductGrid({
  apiUrl,
  locale,
  detailHrefBase,
  emptyLabel,
  errorLabel,
  skeletonLabel,
  query,
  limit,
  skeletonCount,
  showCount = false,
  showingCountTemplate,
  photoComingSoonLabel = "",
}: ProductGridProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Track image URLs that fail to load so we can fall back to the
  // typographic placeholder. A broken Unsplash URL or hotlink-block
  // would otherwise show a torn-image icon.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());

  // Auto-balance: with ≤6 products the desktop grid drops from 4 to 3
  // columns so the last row doesn't leave orphaned cards on the right.
  // Mobile (2) and tablet (3) layouts are unaffected.
  const productCount = state.status === "ready" ? state.products.length : 0;
  const compact = state.status === "ready" && productCount <= 6;
  const gridClasses = useMemo(
    () =>
      compact
        ? "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-3 md:gap-x-6 md:gap-y-12"
        : GRID_CLASSES,
    [compact],
  );

  useEffect(() => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: apiUrl });

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
    const cells = Math.max(2, skeletonCount ?? limit ?? query?.pageSize ?? 8);
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={skeletonLabel}
        className={GRID_CLASSES}
      >
        {Array.from({ length: cells }).map((_, idx) => (
          <div key={idx}>
            <div className="aspect-square w-full skeleton border border-line"></div>
            <div className="mt-3 space-y-2">
              <div className="h-3 w-3/4 skeleton"></div>
              <div className="h-3 w-1/3 skeleton"></div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="py-12 text-center">
        <p className="t-body text-fg">{errorLabel}</p>
      </div>
    );
  }

  if (state.products.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="t-body text-muted">{emptyLabel}</p>
      </div>
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
        <p className="t-caption mb-3 text-faint">{countLabel}</p>
      )}
      <div className={gridClasses}>
        {state.products.map((p, idx) => {
        const price = lowestPrice(p);
        const compareAt = p.variants[0]?.compareAtPrice ?? null;
        // The first row is above the fold on every viewport — eager-load
        // the first four images so the LCP is not deferred. Lazy after.
        const loading = idx < 4 ? "eager" : "lazy";
        const altText = p.imageAlt ?? p.title;
        return (
          <a key={p.id} href={`${detailHrefBase}/${p.slug}`} className="group block">
            <div className="aspect-square w-full overflow-hidden border border-line bg-paper transition-colors duration-150 group-hover:border-line-strong">
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
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-cream p-4">
                  <span className="t-body text-center font-medium text-fg">
                    {p.title}
                  </span>
                  <span className="t-caption text-center text-faint">
                    {photoComingSoonLabel}
                  </span>
                </div>
              )}
            </div>
            <div className="mt-3 space-y-1">
              <h3 className="t-body line-clamp-1 text-fg transition-colors duration-150 group-hover:text-accent">
                {p.title}
              </h3>
              <div className="flex items-baseline gap-2 t-body">
                {price && (
                  <span className="price-figure text-fg">
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

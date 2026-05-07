/**
 * ProductGrid — client island.
 *
 * Why this is a React island instead of an Astro server-render: the
 * storefront builds with `output: "static"` and the API is not necessarily
 * running at build time. To keep `bun run build` deterministic and offline-
 * friendly, the static page renders a "Memuat produk…" placeholder and this
 * island fetches real data from the API once it mounts in the browser.
 *
 * Design notes:
 *
 *   - `PUBLIC_API_URL` is inlined by Vite at build time. The same env var is
 *     read by the build-time SDK calls in `lib/api.ts`, so server and client
 *     stay aligned.
 *
 *   - The card markup mirrors `components/ProductCard.astro`. Astro
 *     components cannot render inside React islands, so a small duplication
 *     is unavoidable. Both stay in sync via the shared Tailwind classes;
 *     when the cart island lands and centralizes more UI, this can collapse
 *     into a single React `<Card>` reused from both Astro and React sides.
 *
 *   - The grid skeleton matches the static placeholder's grid template so
 *     there is no layout shift when data arrives.
 */
import { useEffect, useState } from "react";
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
  loadingLabel: string;
  errorLabel: string;
  query?: ProductGridQuery;
  /** When set, slices the result to at most this many cards (home featured). */
  limit?: number;
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

function placeholderImage(title: string): string {
  return `https://placehold.co/800x800/png?text=${encodeURIComponent(title.slice(0, 24))}`;
}

export default function ProductGrid({
  apiUrl,
  locale,
  detailHrefBase,
  emptyLabel,
  loadingLabel,
  errorLabel,
  query,
  limit,
}: ProductGridProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

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
    return (
      <p
        role="status"
        aria-live="polite"
        className="rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600"
      >
        {loadingLabel}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="rounded border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700"
      >
        {errorLabel}
      </p>
    );
  }

  if (state.products.length === 0) {
    return (
      <p className="rounded border border-neutral-200 bg-neutral-50 p-6 text-center text-sm text-neutral-600">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      {state.products.map((p) => {
        const price = lowestPrice(p);
        const compareAt = p.variants[0]?.compareAtPrice ?? null;
        return (
          <a
            key={p.id}
            href={`${detailHrefBase}/${p.slug}`}
            className="group block rounded-lg border border-neutral-200 bg-white transition-colors hover:border-neutral-400"
          >
            <div className="aspect-square overflow-hidden rounded-t-lg bg-neutral-100">
              <img
                src={placeholderImage(p.title)}
                alt={p.title}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="space-y-1 p-3">
              <h3 className="line-clamp-2 text-sm font-medium text-neutral-900">
                {p.title}
              </h3>
              <div className="flex items-baseline gap-2 text-sm">
                {price && (
                  <span className="price-figure text-neutral-900">
                    {formatMoney(price, { locale })}
                  </span>
                )}
                {compareAt && (
                  <span className="price-figure text-neutral-500 line-through">
                    {formatMoney(compareAt, { locale })}
                  </span>
                )}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

/**
 * SearchResults — client-side search island.
 *
 * Why an island and not server-rendered like /products: the storefront
 * builds with `output: "static"`, so `Astro.url.searchParams` is empty
 * at build time and `?q=...` cannot be observed on the server. A purely
 * SSG'd /search page would always render the empty state regardless of
 * the typed query. This island runs the catalog query against the SDK
 * on the visitor's machine, so typing "kopi" and pressing Enter actually
 * surfaces matching products.
 *
 * URL contract:
 *   - Reads `q` (clamped to 200 chars) and `page` from `window.location`
 *     on mount and on `popstate` so browser back/forward works.
 *   - The header search submits via a normal `<form action="/search">`,
 *     which lands here as a full page load — the island reads the new URL
 *     in its mount path.
 *   - Pagination links navigate with full URLs (the island reads the new
 *     `page` on the resulting load); we do not push history client-side.
 *
 * Renders the same three states the static markup used to declare:
 *   1. No query — calm prompt + link to /products.
 *   2. Query + no results — query echoed back + link to /products.
 *   3. Query + results — heading, count, grid, pagination.
 *
 * Card markup mirrors `ProductGrid` (which mirrors `ProductCard.astro`).
 * Both surfaces stay in sync via the shared utility classes; we duplicate
 * the small render block here rather than import the grid wholesale,
 * because the search page wants its own heading + count + pagination
 * contract that the catalog grid does not have.
 */
import { useEffect, useMemo, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient } from "@mt-commerce/sdk";
import { paginationItems } from "../lib/pagination.js";

const MAX_QUERY_LENGTH = 200;
const PAGE_SIZE = 12;

export type SearchResultsLabels = {
  /** Heading when no query is present. */
  emptyHeading: string;
  /** Body line beneath the empty heading. */
  emptyBody: string;
  /** Heading template when a query is present, with `{query}` token. */
  resultsHeadingTemplate: string;
  /** Count caption template (e.g. "{count} hasil"). */
  countTemplate: string;
  /** Headline template for "no results for {query}". */
  noResultsHeadingTemplate: string;
  /** Body line when there are no results. */
  noResultsBody: string;
  /** Loading state aria-label / inline copy. */
  loading: string;
  /** Error fallback. */
  error: string;
  /** "Browse all products" link. */
  browseAll: string;
  /** Pagination prev / next labels. */
  prevLabel: string;
  nextLabel: string;
};

export type SearchResultsProps = {
  apiUrl: string;
  /** BCP47 locale for `Intl.NumberFormat` (e.g. "id-ID"). */
  locale: string;
  /** Short locale tag (`"id" | "en"`) sent to the API. */
  apiLocale: string;
  /** Path prefix for product detail links. */
  detailHrefBase: string;
  /** Path to /products — empty-state CTA. */
  productsHref: string;
  /** Path to /search itself — pagination + form fallback. */
  searchHref: string;
  labels: SearchResultsLabels;
};

type SearchItem = {
  id: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  variants: Array<{ price: Money; compareAtPrice?: Money | null }>;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      items: SearchItem[];
      total: number;
      page: number;
      totalPages: number;
    }
  | { status: "error" };

const GRID_CLASSES =
  "grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-3 md:gap-x-8 md:gap-y-16 lg:grid-cols-4 lg:gap-x-8 lg:gap-y-20";

function lowestPrice(p: SearchItem): Money | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

/**
 * Read `q` and `page` from `window.location.search`. Returns `{ q: "" }`
 * during SSR (the island is `client:load` so the only way this runs on
 * the server is during framework warm-up — the empty-state branch is
 * a safe default).
 */
function readQuery(): { q: string; page: number } {
  if (typeof window === "undefined") return { q: "", page: 1 };
  const params = new URLSearchParams(window.location.search);
  const rawQ = params.get("q") ?? "";
  const q = rawQ.trim().slice(0, MAX_QUERY_LENGTH);
  const rawPage = params.get("page");
  const page = rawPage ? Math.max(1, Number.parseInt(rawPage, 10) || 1) : 1;
  return { q, page };
}

export default function SearchResults({
  apiUrl,
  locale,
  apiLocale,
  detailHrefBase,
  productsHref,
  searchHref,
  labels,
}: SearchResultsProps) {
  const [{ q, page }, setQuery] = useState<{ q: string; page: number }>(
    readQuery,
  );
  // The fetched results, plus pagination metadata. Resets to the loading
  // sentinel whenever the query changes; the no-query branch reads the
  // sentinel without ever entering the fetch effect.
  const [state, setState] = useState<LoadState>(() =>
    readQuery().q.length === 0 ? { status: "idle" } : { status: "loading" },
  );
  const [brokenImages, setBrokenImages] = useState<Set<string>>(
    () => new Set(),
  );

  // Re-read the URL on back/forward so users navigating their search
  // history land on the right results without a manual refresh.
  useEffect(() => {
    function onPopState() {
      const next = readQuery();
      setQuery(next);
      // Reset state synchronously alongside the query change so the
      // empty-query branch renders the no-query view without a stale
      // results flash.
      setState(
        next.q.length === 0 ? { status: "idle" } : { status: "loading" },
      );
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const client = useMemo(
    () => createClient({ baseUrl: apiUrl, locale: apiLocale }),
    [apiUrl, apiLocale],
  );

  useEffect(() => {
    if (q.length === 0) return;
    const controller = new AbortController();
    // Flipping to "loading" inside the effect is intentional: the q-change
    // here is the trigger, and any cached results from a previous query are
    // no longer valid until the new fetch resolves. Same shape as ProductGrid.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });

    async function load() {
      try {
        const result = await client.storefront.products.list(
          { search: q, page, pageSize: PAGE_SIZE },
          { signal: controller.signal },
        );
        const items: SearchItem[] = result.data.map((p) => ({
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
        const totalPages = Math.max(
          1,
          Math.ceil(result.total / result.pageSize),
        );
        setState({
          status: "ready",
          items,
          total: result.total,
          page: result.page,
          totalPages,
        });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        if ((err as { code?: string } | null)?.code === "request_aborted")
          return;
        console.error("[storefront] SearchResults fetch failed:", err);
        setState({ status: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, [client, q, page]);

  // No-query state — calm prompt + browse-all link. Mirrors the previous
  // server-rendered empty markup.
  if (q.length === 0) {
    return (
      <section className="max-w-[480px]">
        <h1 className="t-h1 text-fg mb-3">{labels.emptyHeading}</h1>
        <p className="t-body text-muted">{labels.emptyBody}</p>
        <a
          href={productsHref}
          className="t-body text-fg hover:text-accent mt-8 inline-flex items-center gap-2 underline-offset-[6px] transition-colors duration-200 hover:underline"
        >
          {labels.browseAll} &rarr;
        </a>
      </section>
    );
  }

  const heading = labels.resultsHeadingTemplate.replace("{query}", q);

  return (
    <>
      <header className="mb-10 md:mb-14">
        <h1 className="t-h1 text-fg">{heading}</h1>
        {state.status === "ready" && (
          <p
            className="t-body text-muted mt-3"
            aria-live="polite"
            aria-atomic="true"
          >
            {labels.countTemplate.replace("{count}", String(state.total))}
          </p>
        )}
      </header>

      {state.status === "loading" && (
        <div
          role="status"
          aria-live="polite"
          aria-label={labels.loading}
          className={GRID_CLASSES}
        >
          {Array.from({ length: 8 }).map((_, idx) => (
            <div key={idx}>
              <div className="skeleton aspect-square w-full" />
              <div className="mt-4 space-y-2">
                <div className="skeleton h-3 w-3/4" />
                <div className="skeleton h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {state.status === "error" && (
        <p role="alert" className="t-body text-muted py-16">
          {labels.error}
        </p>
      )}

      {state.status === "ready" && state.items.length === 0 && (
        <section className="max-w-[480px]">
          <div aria-live="polite" aria-atomic="true">
            <p className="t-body text-fg">
              {labels.noResultsHeadingTemplate.replace("{query}", q)}
            </p>
            <p className="t-body text-muted mt-3">{labels.noResultsBody}</p>
          </div>
          <a
            href={productsHref}
            className="t-body text-fg hover:text-accent mt-8 inline-flex items-center gap-2 underline-offset-[6px] transition-colors duration-200 hover:underline"
          >
            {labels.browseAll} &rarr;
          </a>
        </section>
      )}

      {state.status === "ready" && state.items.length > 0 && (
        <>
          <div className={GRID_CLASSES}>
            {state.items.map((p, idx) => {
              const price = lowestPrice(p);
              const compareAt = p.variants[0]?.compareAtPrice ?? null;
              const altText = p.imageAlt ?? p.title;
              const eager = idx < 4;
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
                        loading={eager ? "eager" : "lazy"}
                        decoding="async"
                        onError={() => {
                          setBrokenImages((prev) => {
                            if (prev.has(p.id)) return prev;
                            const next = new Set(prev);
                            next.add(p.id);
                            return next;
                          });
                        }}
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

          {state.totalPages > 1 && (
            <Pagination
              page={state.page}
              totalPages={state.totalPages}
              q={q}
              searchHref={searchHref}
              prevLabel={labels.prevLabel}
              nextLabel={labels.nextLabel}
            />
          )}
        </>
      )}
    </>
  );
}

function Pagination({
  page,
  totalPages,
  q,
  searchHref,
  prevLabel,
  nextLabel,
}: {
  page: number;
  totalPages: number;
  q: string;
  searchHref: string;
  prevLabel: string;
  nextLabel: string;
}) {
  const buildHref = (p: number) =>
    `${searchHref}?q=${encodeURIComponent(q)}&page=${p}`;
  const items = paginationItems(page, totalPages);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  return (
    <nav
      className="t-caption mt-20 flex items-center justify-center gap-4"
      aria-label="Pagination"
    >
      <a
        href={hasPrev ? buildHref(page - 1) : undefined}
        aria-disabled={!hasPrev}
        className={
          hasPrev
            ? "text-fg hover:text-accent transition-colors duration-150"
            : "text-faint pointer-events-none transition-colors duration-150"
        }
      >
        &larr; {prevLabel}
      </a>
      <span className="text-faint" aria-hidden="true">
        ·
      </span>
      <ul className="flex items-center gap-4">
        {items.map((item) =>
          item.type === "ellipsis" ? (
            <li key={item.key} aria-hidden="true" className="text-faint">
              …
            </li>
          ) : (
            <li key={item.page}>
              <a
                href={buildHref(item.page)}
                aria-current={item.page === page ? "page" : undefined}
                className={
                  item.page === page
                    ? "price-figure text-fg transition-colors duration-150"
                    : "price-figure text-faint hover:text-accent transition-colors duration-150"
                }
              >
                {item.page}
              </a>
            </li>
          ),
        )}
      </ul>
      <span className="text-faint" aria-hidden="true">
        ·
      </span>
      <a
        href={hasNext ? buildHref(page + 1) : undefined}
        aria-disabled={!hasNext}
        className={
          hasNext
            ? "text-fg hover:text-accent transition-colors duration-150"
            : "text-faint pointer-events-none transition-colors duration-150"
        }
      >
        {nextLabel} &rarr;
      </a>
    </nav>
  );
}

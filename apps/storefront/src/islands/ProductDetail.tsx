/**
 * ProductDetail — client island for the product detail page.
 *
 * Same rationale as `ProductGrid`: the storefront builds statically, so
 * detail pages cannot count on the API being reachable at build time. We
 * render a placeholder; this island fetches the product by slug once it
 * mounts in the browser.
 *
 * Layout (Saturdays NYC × Muji):
 *
 *   - Hero image: full-bleed on mobile, ~60vh on desktop. The image is
 *     1:1 aspect to keep the catalog visually consistent.
 *   - Below the hero: a single 640px-max centered column with breadcrumbs,
 *     title (display), price, description, variant chips, and the
 *     primary "Add to cart" button at 48px height.
 *   - "Produk serupa" section: a 4-card grid using the same card markup
 *     as the listing page, populated from a second SDK call (same-category
 *     newest, excluding the current product).
 *   - Sticky mobile bottom bar: the action block becomes `position: sticky`
 *     near the bottom of the viewport on small screens via Tailwind's
 *     `md:static`. No JS needed.
 *
 * Internally it reuses `VariantSelector` and `AddToCartButton`.
 */
import { useEffect, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient, type Product as SdkProduct } from "@mt-commerce/sdk";
import VariantSelector, { type VariantOption } from "./VariantSelector";
import AddToCartButton from "./AddToCartButton";

export type ProductDetailProps = {
  apiUrl: string;
  slug: string;
  locale: string;
  loadingLabel: string;
  errorLabel: string;
  notFoundLabel: string;
  variantsHeading: string;
  compareAtLabel: string;
  addToCartLabel: string;
  outOfStockLabel: string;
  /** Localized "Beranda / Home" breadcrumb root label. */
  breadcrumbHomeLabel: string;
  /** Localized "Produk serupa" / "Related products" heading. */
  relatedTitle: string;
  /** Path prefix for sibling product links — locale-aware, page builds it. */
  detailHrefBase: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; product: SdkProduct; related: SdkProduct[] }
  | { status: "not_found" }
  | { status: "error" };

function lowestPrice(p: SdkProduct): Money | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

export default function ProductDetail(props: ProductDetailProps) {
  const {
    apiUrl,
    slug,
    locale,
    loadingLabel,
    errorLabel,
    notFoundLabel,
    variantsHeading,
    compareAtLabel,
    addToCartLabel,
    outOfStockLabel,
    breadcrumbHomeLabel,
    relatedTitle,
    detailHrefBase,
  } = props;

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: apiUrl });

    async function load() {
      try {
        const product = await client.storefront.products.bySlug(slug, {
          signal: controller.signal,
        });

        // Best-effort related-products fetch. A failure here does NOT
        // surface as the page error — the user still sees the product.
        // We pull a small page from the same category and filter the
        // current product out. If the product has no category, we fall
        // back to "newest across all categories".
        let related: SdkProduct[] = [];
        try {
          const result = await client.storefront.products.list(
            {
              pageSize: 8,
              sort: "newest",
              ...(product.categoryIds[0] ? { categorySlug: product.categoryIds[0] } : {}),
            },
            { signal: controller.signal },
          );
          related = result.data
            .filter((p) => p.id !== product.id)
            .slice(0, 4);
        } catch {
          // Swallow — a failed related-products call must not break the page.
        }

        setState({ status: "ready", product, related });
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        const code = (err as { code?: string } | null)?.code;
        if (code === "request_aborted") return;
        if (code === "not_found") {
          setState({ status: "not_found" });
          return;
        }
        console.error(`[storefront] ProductDetail(${slug}) fetch failed:`, err);
        setState({ status: "error" });
      }
    }

    void load();
    return () => controller.abort();
  }, [apiUrl, slug]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={loadingLabel}
        className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-12"
      >
        <div className="aspect-square w-full skeleton border border-line md:aspect-[16/10]"></div>
        <div className="mx-auto mt-10 max-w-[640px] space-y-4">
          <div className="h-3 w-32 skeleton"></div>
          <div className="h-9 w-3/4 skeleton"></div>
          <div className="h-5 w-32 skeleton"></div>
          <div className="h-3 w-full skeleton"></div>
          <div className="h-3 w-5/6 skeleton"></div>
        </div>
      </div>
    );
  }

  if (state.status === "not_found") {
    return (
      <div className="mx-auto max-w-[640px] px-4 py-24 text-center md:px-8">
        <p className="t-body text-muted">{notFoundLabel}</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="mx-auto max-w-[640px] px-4 py-24 text-center md:px-8">
        <p className="t-body text-fg">{errorLabel}</p>
      </div>
    );
  }

  const { product, related } = state;
  const description = product.description ?? "";
  const variantOptions: VariantOption[] = product.variants.map((v) => ({
    id: v.id,
    name: v.title ?? v.sku,
    price: v.price,
    ...(v.compareAtPrice ? { compareAt: v.compareAtPrice } : {}),
    available: true,
  }));
  const firstVariant = variantOptions[0];
  const base = lowestPrice(product);
  const altText = product.imageAlt ?? product.title;

  return (
    <article>
      {/* Hero image — full-bleed, no border on mobile, framed on desktop. */}
      <section className="bg-cream">
        <div className="mx-auto max-w-[1280px] px-0 pt-0 md:px-8 md:pt-8">
          <div className="aspect-square w-full overflow-hidden border-line bg-paper md:aspect-[16/10] md:border md:max-h-[60vh]">
            {product.imageUrl ? (
              <img
                src={product.imageUrl}
                alt={altText}
                loading="eager"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-cream">
                <span className="t-caption uppercase tracking-wide text-faint">
                  {product.title}
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Body — single centered column. */}
      <section className="mx-auto max-w-[640px] px-4 pb-32 pt-8 md:px-8 md:pb-24 md:pt-12">
        {/* Breadcrumbs */}
        <nav aria-label="Breadcrumb" className="t-caption uppercase tracking-wide text-muted">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <a href={detailHrefBase.replace(/\/products\/?$/, "/")} className="hover:text-fg">
                {breadcrumbHomeLabel}
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <a href={detailHrefBase} className="hover:text-fg">
                Produk
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li className="truncate text-fg">{product.title}</li>
          </ol>
        </nav>

        {/* Title + price */}
        <header className="mt-6">
          <h1 className="t-display text-fg">{product.title}</h1>
          {base && (
            <p className="mt-4 t-h1 price-figure text-fg">
              {formatMoney(base, { locale })}
            </p>
          )}
        </header>

        {/* Description */}
        {description && (
          <p className="mt-6 t-body text-muted">{description}</p>
        )}

        {/*
         * Variant + add-to-cart.
         *
         * Sticky on mobile only: the wrapper stays in flow on desktop;
         * on mobile it sits at the bottom of the viewport once the user
         * scrolls past the hero, rendered as a thin bar with the price
         * and the primary action. Implemented purely with CSS sticky.
         */}
        {firstVariant && (
          <>
            <div className="mt-10 space-y-6">
              <VariantSelector
                variants={variantOptions}
                locale={locale}
                heading={variantsHeading}
                compareAtLabel={compareAtLabel}
              />
            </div>

            <div className="sticky bottom-0 -mx-4 mt-8 border-t border-line bg-cream px-4 py-4 md:static md:m-0 md:mt-10 md:border-0 md:bg-transparent md:p-0">
              <AddToCartButton
                variantId={firstVariant.id}
                label={addToCartLabel}
                soldOutLabel={outOfStockLabel}
                soldOut={!firstVariant.available}
              />
            </div>
          </>
        )}
      </section>

      {/* Related products. Quietly hidden when there are none. */}
      {related.length > 0 && (
        <section className="mx-auto max-w-[1280px] px-4 pb-24 md:px-8 md:pb-32">
          <h2 className="t-h1 text-fg">{relatedTitle}</h2>
          <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4 md:gap-x-8 md:gap-y-12">
            {related.map((p) => {
              const price = lowestPrice(p);
              const altRelated = p.imageAlt ?? p.title;
              return (
                <a key={p.id} href={`${detailHrefBase}/${p.slug}`} className="group block">
                  <div className="aspect-square w-full overflow-hidden border border-line bg-paper transition-colors duration-150 group-hover:border-line-strong">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={altRelated}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-cream">
                        <span className="t-caption uppercase tracking-wide text-faint">
                          {p.title}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 space-y-1">
                    <h3 className="t-body line-clamp-1 font-medium text-fg transition-colors duration-150 group-hover:text-accent">
                      {p.title}
                    </h3>
                    {price && (
                      <p className="price-figure t-body text-fg">
                        {formatMoney(price, { locale })}
                      </p>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </article>
  );
}

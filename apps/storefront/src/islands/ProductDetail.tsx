/**
 * ProductDetail — client island for the product detail page.
 *
 * Same rationale as `ProductGrid`: the storefront builds statically, so
 * detail pages cannot count on the API being reachable at build time. We
 * render a placeholder; this island fetches the product by slug once it
 * mounts in the browser.
 *
 * Layout (Saturdays NYC × Muji, post-redesign):
 *
 *   - Hero image: FULL-BLEED at the top of the page. Width 100%, max
 *     height ~80vh on desktop, object-cover. No card border, no breadcrumb
 *     bar above it. The image takes the visitor IN.
 *
 *   - Below the hero: a single 640px-max centered column with generous
 *     vertical padding. Inside the column, in order:
 *       1. Overline pill — category name (linking back to /products?category=…),
 *          11px caps, weight 500. This replaces the usual breadcrumb trail.
 *       2. Title — `t-display` weight 400.
 *       3. Price — `t-h1` weight 400, tabular-nums, `text-fg`.
 *       4. Description — `t-body` left-aligned, generous spacing.
 *       5. Variant chips (only when >1 variant).
 *       6. Add-to-cart — full-width terracotta, 48px height.
 *       7. Specs/info — quiet two-column key/value list (reserved for future).
 *
 *   - Related products: small overline + a 3-column grid in the same
 *     minimal card style (no border, muted price).
 *
 *   - Mobile sticky CTA: the add-to-cart wrapper sticks to the bottom of
 *     the viewport on small screens via Tailwind's `sticky` + breakpoint
 *     unstick. No JS required.
 */
import { useEffect, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient, type Product as SdkProduct } from "@mt-commerce/sdk";
import VariantSelector, { type VariantOption } from "./VariantSelector";
import AddToCartButton from "./AddToCartButton";

export type ProductDetailProps = {
  apiUrl: string;
  slug: string;
  /** BCP47 locale for currency formatting (e.g. "id-ID", "en-US"). */
  locale: string;
  /**
   * Short locale tag (`"id" | "en"`) sent as `?locale=` to the API so
   * product `title` / `description` come back already translated. Kept
   * separate from `locale` (BCP47) — see ProductGrid for the rationale.
   */
  apiLocale: string;
  loadingLabel: string;
  errorLabel: string;
  notFoundLabel: string;
  variantsHeading: string;
  compareAtLabel: string;
  addToCartLabel: string;
  outOfStockLabel: string;
  /** Localized "Beranda / Home" label — kept in props for backwards compat. */
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
    apiLocale,
    loadingLabel,
    errorLabel,
    notFoundLabel,
    variantsHeading,
    compareAtLabel,
    addToCartLabel,
    outOfStockLabel,
    relatedTitle,
    detailHrefBase,
  } = props;

  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    // Bake the API locale into the client — see ProductGrid for the
    // rationale. Without this the API would resolve from the browser's
    // Accept-Language, which can disagree with the URL the visitor is on.
    const client = createClient({ baseUrl: apiUrl, locale: apiLocale });

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
            .slice(0, 3);
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
  }, [apiUrl, apiLocale, slug]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={loadingLabel}
      >
        {/* Full-bleed hero skeleton — matches the live layout. */}
        <div className="aspect-[4/3] w-full skeleton md:aspect-[16/9] md:max-h-[80vh]"></div>
        <div className="mx-auto mt-12 max-w-[640px] space-y-4 px-5 md:px-8 md:mt-16">
          <div className="h-3 w-24 skeleton"></div>
          <div className="h-9 w-3/4 skeleton"></div>
          <div className="h-6 w-32 skeleton"></div>
          <div className="h-3 w-full skeleton"></div>
          <div className="h-3 w-5/6 skeleton"></div>
        </div>
      </div>
    );
  }

  if (state.status === "not_found") {
    return (
      <div className="mx-auto max-w-[640px] px-5 py-32 text-center md:px-8">
        <p className="t-body text-muted">{notFoundLabel}</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div role="alert" className="mx-auto max-w-[640px] px-5 py-32 text-center md:px-8">
        <p className="t-body text-muted">{errorLabel}</p>
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

  // First category id used as the slug-shaped overline link. The catalog
  // currently exposes the id as the slug-equivalent; when the SDK exposes
  // a real slug field we can swap it without touching the layout.
  const categorySlug = product.categoryIds[0];
  const categoryHref = categorySlug
    ? `${detailHrefBase}?category=${categorySlug}`
    : detailHrefBase;

  return (
    <article>
      {/* Hero image — FULL BLEED, no border, no breadcrumb above it. */}
      <section className="bg-cream">
        <div className="w-full overflow-hidden">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={altText}
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className="h-auto max-h-[80vh] w-full object-cover"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center md:aspect-[16/9] md:max-h-[80vh]">
              <span className="t-body text-fg">{product.title}</span>
            </div>
          )}
        </div>
      </section>

      {/* Body — single centered narrow column, generous vertical room. */}
      <section className="mx-auto max-w-[640px] px-5 pb-32 pt-12 md:px-8 md:pb-24 md:pt-20">
        {/* Overline category — replaces the breadcrumb trail. */}
        <a
          href={categoryHref}
          className="t-overline text-muted transition-colors duration-150 hover:text-accent"
        >
          {categorySlug ?? ""}
        </a>

        {/* Title + price — generous spacing between, no horizontal rule. */}
        <header className="mt-4">
          <h1 className="t-display text-fg">{product.title}</h1>
          {base && (
            <p className="mt-6 t-h1 price-figure text-fg">
              {formatMoney(base, { locale })}
            </p>
          )}
        </header>

        {/* Description — left-aligned body, muted. */}
        {description && (
          <p className="mt-10 t-body text-muted">{description}</p>
        )}

        {/* Variants + CTA. The CTA is sticky on mobile, in-flow on desktop. */}
        {firstVariant && (
          <>
            <div className="mt-12">
              <VariantSelector
                variants={variantOptions}
                locale={locale}
                heading={variantsHeading}
                compareAtLabel={compareAtLabel}
              />
            </div>

            <div className="sticky bottom-0 -mx-5 mt-10 border-t border-line bg-cream px-5 py-4 md:static md:m-0 md:mt-12 md:border-0 md:bg-transparent md:p-0">
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
        <section className="mx-auto max-w-[1280px] px-5 pb-32 md:px-8 md:pb-40">
          <p className="t-overline text-muted">{relatedTitle}</p>
          <div className="mt-10 grid grid-cols-2 gap-x-5 gap-y-12 md:mt-14 md:grid-cols-3 md:gap-x-10 md:gap-y-16 lg:gap-x-12">
            {related.map((p) => {
              const price = lowestPrice(p);
              const altRelated = p.imageAlt ?? p.title;
              return (
                <a
                  key={p.id}
                  href={`${detailHrefBase}/${p.slug}`}
                  className="group block"
                >
                  <div className="aspect-square w-full overflow-hidden bg-cream">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={altRelated}
                        loading="lazy"
                        decoding="async"
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
                    {price && (
                      <p className="price-figure t-body text-muted">
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

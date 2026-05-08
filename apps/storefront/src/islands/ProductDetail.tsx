/**
 * ProductDetail — client island for the product detail page.
 *
 * Same rationale as `ProductGrid`: when the page's frontmatter could fetch
 * the product at request time, it does — and forwards the result via
 * `initialProduct`. The island renders that synchronously, so visitors
 * never see a "Memuat produk…" placeholder on the happy path. The
 * client-side fetch only runs when:
 *
 *   1. The build was offline (no `initialProduct` was passed — same
 *      progressive-hydration property as before), or
 *   2. `slug` changed after mount (rare in practice; ClientRouter remounts
 *      the island per page rather than re-using it across products).
 *
 * Related products are still fetched client-side. Their absence does not
 * break the page, and seeding them at request time would inflate the page
 * payload for a section visitors may never scroll to.
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
import { useEffect, useRef, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import { createClient, type Product as SdkProduct } from "@mt-commerce/sdk";
import VariantSelector, { type VariantOption } from "./VariantSelector";
import AddToCartButton from "./AddToCartButton";

/**
 * Slim, locale-resolved product shape the page hands the island when the
 * build-time fetch succeeded. Pages serialise a `StoreProduct` into this
 * via `toInitialProduct` below; the island needs no further locale lookups.
 */
export type InitialProduct = {
  id: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string | null;
  imageAlt: string | null;
  categoryIds: string[];
  variants: Array<{
    id: string;
    title: string;
    sku: string;
    price: Money;
    compareAtPrice: Money | null;
  }>;
};

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
  /** Localized success-flash label, e.g. "Ditambahkan" / "Added". */
  addedLabel: string;
  /** Localized generic error copy for cart failures. */
  cartErrorLabel: string;
  /** Localized "Beranda / Home" label — kept in props for backwards compat. */
  breadcrumbHomeLabel: string;
  /** Localized "Produk serupa" / "Related products" heading. */
  relatedTitle: string;
  /** Path prefix for sibling product links — locale-aware, page builds it. */
  detailHrefBase: string;
  /**
   * Optional request-time payload. When present, the island renders the
   * product synchronously on first mount. `slug` must match the product's
   * slug (the page builds them together). When absent, the island falls
   * back to a client-side fetch — preserves the original offline-build
   * behaviour.
   */
  initialProduct?: InitialProduct;
};

/**
 * Renderable shape used inside the component. Both `initialProduct` and the
 * SDK fetch land here so the rest of the JSX has a single union to walk.
 */
type RenderProduct = {
  id: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string | null;
  imageAlt: string | null;
  categoryIds: string[];
  variants: Array<{
    id: string;
    title: string | null;
    sku: string;
    price: Money;
    compareAtPrice: Money | null;
  }>;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; product: RenderProduct; related: SdkProduct[] }
  | { status: "not_found" }
  | { status: "error" };

function lowestPrice(p: RenderProduct): Money | null {
  if (p.variants.length === 0) return null;
  let lowest = p.variants[0]!.price;
  for (const v of p.variants) {
    if (v.price.amount < lowest.amount) lowest = v.price;
  }
  return lowest;
}

function adaptInitial(initial: InitialProduct): RenderProduct {
  return {
    id: initial.id,
    slug: initial.slug,
    title: initial.title,
    description: initial.description,
    imageUrl: initial.imageUrl,
    imageAlt: initial.imageAlt,
    categoryIds: initial.categoryIds,
    variants: initial.variants.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
    })),
  };
}

function adaptSdk(p: SdkProduct): RenderProduct {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description ?? "",
    imageUrl: p.imageUrl,
    imageAlt: p.imageAlt,
    categoryIds: p.categoryIds,
    variants: p.variants.map((v) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
    })),
  };
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
    addedLabel,
    cartErrorLabel,
    relatedTitle,
    detailHrefBase,
    initialProduct,
  } = props;

  const [state, setState] = useState<LoadState>(() => {
    if (initialProduct && initialProduct.slug === slug) {
      return {
        status: "ready",
        product: adaptInitial(initialProduct),
        related: [],
      };
    }
    return { status: "loading" };
  });

  // Skip the kick-off fetch when we just seeded from `initialProduct`. The
  // ref clears after the first effect run so a later slug change still
  // triggers a refetch.
  const skipNextFetchRef = useRef<boolean>(
    initialProduct != null && initialProduct.slug === slug,
  );

  useEffect(() => {
    const controller = new AbortController();
    const client = createClient({ baseUrl: apiUrl, locale: apiLocale });

    async function loadFull() {
      // Full load — fetches the product AND its related items. Used when
      // the page didn't seed `initialProduct` (offline-build fallback) or
      // when the slug changed after the initial mount.
      try {
        const product = await client.storefront.products.bySlug(slug, {
          signal: controller.signal,
        });

        let related: SdkProduct[] = [];
        try {
          const result = await client.storefront.products.list(
            {
              pageSize: 8,
              sort: "newest",
              ...(product.categoryIds[0]
                ? { categorySlug: product.categoryIds[0] }
                : {}),
            },
            { signal: controller.signal },
          );
          related = result.data.filter((p) => p.id !== product.id).slice(0, 3);
        } catch {
          // Swallow — a failed related-products call must not break the page.
        }

        if (controller.signal.aborted) return;
        setState({
          status: "ready",
          product: adaptSdk(product),
          related,
        });
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

    async function loadRelatedOnly() {
      // Seeded path — only the related strip is missing. A failure here
      // is silent (the user already sees the product); the strip simply
      // doesn't appear.
      if (!initialProduct) return;
      try {
        const result = await client.storefront.products.list(
          {
            pageSize: 8,
            sort: "newest",
            ...(initialProduct.categoryIds[0]
              ? { categorySlug: initialProduct.categoryIds[0] }
              : {}),
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const filtered = result.data
          .filter((p) => p.id !== initialProduct.id)
          .slice(0, 3);
        setState((prev) =>
          prev.status === "ready" ? { ...prev, related: filtered } : prev,
        );
      } catch {
        // Best-effort — same swallow rationale.
      }
    }

    if (skipNextFetchRef.current) {
      // We seeded synchronously from `initialProduct`. Don't refetch the
      // product (it's already on screen) — just hydrate the related strip
      // in the background.
      skipNextFetchRef.current = false;
      void loadRelatedOnly();
    } else {
      // Cold or slug-changed path — show the skeleton and load fresh.
      // (`setState({ status: "loading" })` would be a no-op when the
      // component is already loading; cheap and explicit.)
      setState({ status: "loading" });
      void loadFull();
    }

    return () => controller.abort();
    // `initialProduct` is captured by the seed branch; we don't include it
    // in deps because Astro hands the island a fresh tree per page and a
    // changing reference would just trigger redundant fetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, apiLocale, slug]);

  if (state.status === "loading") {
    return (
      <div role="status" aria-live="polite" aria-label={loadingLabel}>
        {/* Full-bleed hero skeleton — matches the live layout. */}
        <div className="skeleton aspect-[4/3] w-full md:aspect-[16/9] md:max-h-[80vh]"></div>
        <div className="mx-auto mt-12 max-w-[640px] space-y-4 px-5 md:mt-16 md:px-8">
          <div className="skeleton h-3 w-24"></div>
          <div className="skeleton h-9 w-3/4"></div>
          <div className="skeleton h-6 w-32"></div>
          <div className="skeleton h-3 w-full"></div>
          <div className="skeleton h-3 w-5/6"></div>
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
      <div
        role="alert"
        className="mx-auto max-w-[640px] px-5 py-32 text-center md:px-8"
      >
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
      {/*
        Hero image — FULL BLEED, no border, no breadcrumb above it.
        The wrapper reserves a 4:3 / 16:9 aspect ratio so the eventual
        image cannot push later content down — the previous unsized
        `<img>` was the source of the page's only layout shift (CLS 0.036
        in Lighthouse). The image fills the wrapper and crops via
        `object-cover`, matching the no-image placeholder shape.
      */}
      <section className="bg-cream">
        <div className="aspect-[4/3] w-full overflow-hidden md:aspect-[16/9] md:max-h-[80vh]">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={altText}
              loading="eager"
              decoding="async"
              fetchPriority="high"
              width={1600}
              height={900}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="t-body text-fg">{product.title}</span>
            </div>
          )}
        </div>
      </section>

      {/* Body — single centered narrow column, generous vertical room. */}
      <section className="mx-auto max-w-[640px] px-5 pt-12 pb-32 md:px-8 md:pt-20 md:pb-24">
        {/* Overline category — replaces the breadcrumb trail. */}
        <a
          href={categoryHref}
          className="t-overline text-muted hover:text-accent transition-colors duration-150"
        >
          {categorySlug ?? ""}
        </a>

        {/* Title + price — generous spacing between, no horizontal rule. */}
        <header className="mt-4">
          <h1 className="t-display text-fg">{product.title}</h1>
          {base && (
            <p className="t-h1 price-figure text-fg mt-6">
              {formatMoney(base, { locale })}
            </p>
          )}
        </header>

        {/* Description — left-aligned body, muted. */}
        {description && (
          <p className="t-body text-muted mt-10">{description}</p>
        )}

        {/* Variants + CTA. The CTA is sticky on mobile, in-flow on desktop. */}
        {firstVariant && (
          <>
            <div className="mt-12">
              <VariantSelector
                productId={product.id}
                variants={variantOptions}
                locale={locale}
                heading={variantsHeading}
                compareAtLabel={compareAtLabel}
              />
            </div>

            <div className="border-line bg-cream sticky bottom-0 -mx-5 mt-10 border-t px-5 py-4 md:static md:m-0 md:mt-12 md:border-0 md:bg-transparent md:p-0">
              <AddToCartButton
                productId={product.id}
                variantId={firstVariant.id}
                label={addToCartLabel}
                soldOutLabel={outOfStockLabel}
                addedLabel={addedLabel}
                errorLabel={cartErrorLabel}
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
              const price =
                p.variants.length > 0
                  ? p.variants.reduce<Money>(
                      (lo, v) => (v.price.amount < lo.amount ? v.price : lo),
                      p.variants[0]!.price,
                    )
                  : null;
              const altRelated = p.imageAlt ?? p.title;
              return (
                <a
                  key={p.id}
                  href={`${detailHrefBase}/${p.slug}`}
                  className="group block"
                >
                  <div className="bg-cream aspect-square w-full overflow-hidden">
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

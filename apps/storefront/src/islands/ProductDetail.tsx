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
 *   - Related products: small overline + a 4-column grid at lg
 *     (3-up tablet, 2-up mobile) in the same minimal card style
 *     (no border, muted price). Mirrors `ProductGrid`'s breakpoints.
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
  /** Localized "Beranda / Home" label for the visible breadcrumb. */
  breadcrumbHomeLabel: string;
  /** Localized "Produk / Products" label for the visible breadcrumb. */
  breadcrumbProductsLabel: string;
  /** Locale-aware href for the breadcrumb's home link. */
  homeHref: string;
  /** Localized "Jumlah / Quantity" label for the stepper, sr-only. */
  quantityLabel: string;
  /** Localized aria-label for the +/- stepper buttons. */
  quantityIncreaseLabel: string;
  quantityDecreaseLabel: string;
  /**
   * Localized shipping caption shown next to the CTA — a calm, factual
   * "Pengiriman dari Jakarta · 2-5 hari kerja · mulai dari Rp 15.000".
   * Static copy by design: it answers "if I add this, when does it
   * arrive and how much?" before the user is forced through checkout.
   */
  shippingEtaLabel: string;
  /** Localized "Produk serupa" / "Related products" heading. */
  relatedTitle: string;
  /** Path prefix for sibling product links — locale-aware, page builds it. */
  detailHrefBase: string;
  /**
   * Resolved, localized name of the product's first category (e.g. "Kerajinan").
   * Looked up server-side against `listCategories(locale)`; absent when the
   * lookup failed or the product has no category. The overline is hidden
   * rather than falling back to the raw slug/id.
   */
  categoryName?: string;
  /** Href for the category overline — built by the page, locale-aware. */
  categoryHref?: string;
  /** Localized leading text of the inline contact line, e.g. "Ada pertanyaan tentang produk ini?". */
  contactInlineText: string;
  /** Localized CTA portion of the inline contact line, e.g. "Hubungi kami.". */
  contactInlineCta: string;
  /** Locale-aware href the inline contact link points at. */
  contactHref: string;
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
    breadcrumbHomeLabel,
    breadcrumbProductsLabel,
    homeHref,
    quantityLabel,
    quantityIncreaseLabel,
    quantityDecreaseLabel,
    shippingEtaLabel,
    relatedTitle,
    detailHrefBase,
    categoryName,
    categoryHref,
    contactInlineText,
    contactInlineCta,
    contactHref,
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

  // Quantity stepper state. Lives here (not in AddToCartButton) so the
  // visible -/+ controls can sit beside the CTA and so a successful add
  // can reset us back to 1 — the next add shouldn't carry the previous
  // count forward by surprise.
  const [quantity, setQuantity] = useState<number>(1);
  const QUANTITY_MAX = 99;

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
          related = result.data.filter((p) => p.id !== product.id).slice(0, 4);
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
          .slice(0, 4);
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

  return (
    <article>
      {/*
        Visible breadcrumb. The PDP previously hid it under a single
        category overline below the hero; that lost wayfinding for users
        who deep-linked into a product. Format: Beranda · Produk · [Cat].
        We omit the product title (it's the H1 right below) so the row
        stays short. Sits inside the same container width as the body.
      */}
      <nav
        aria-label="Breadcrumb"
        className="mx-auto max-w-[1280px] px-5 pt-5 md:px-8 md:pt-6"
      >
        <ol className="t-caption flex flex-wrap items-center gap-x-2">
          <li>
            <a
              href={homeHref}
              className="text-muted hover:text-accent transition-colors duration-150"
            >
              {breadcrumbHomeLabel}
            </a>
          </li>
          <li aria-hidden="true" className="text-faint">
            ·
          </li>
          <li>
            <a
              href={detailHrefBase}
              className="text-muted hover:text-accent transition-colors duration-150"
            >
              {breadcrumbProductsLabel}
            </a>
          </li>
          {categoryName && categoryHref && (
            <>
              <li aria-hidden="true" className="text-faint">
                ·
              </li>
              <li>
                <a
                  href={categoryHref}
                  className="text-muted hover:text-accent transition-colors duration-150"
                >
                  {categoryName}
                </a>
              </li>
            </>
          )}
        </ol>
      </nav>

      {/*
        Hero image — FULL BLEED, no border, no breadcrumb above it.
        The wrapper reserves a 4:3 / 16:9 aspect ratio so the eventual
        image cannot push later content down — the previous unsized
        `<img>` was the source of the page's only layout shift (CLS 0.036
        in Lighthouse). The image fills the wrapper and crops via
        `object-cover`, matching the no-image placeholder shape.
      */}
      <section className="bg-cream mt-5 md:mt-6">
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
              // Pairs with the matching name on `ProductCard.astro` —
              // the browser morphs a clicked card image into this hero
              // across the Astro view-transition swap. Unsupporting
              // browsers fall through to a normal swap.
              style={{ viewTransitionName: `pdp-image-${product.slug}` }}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="t-body text-fg">{product.title}</span>
            </div>
          )}
        </div>
      </section>

      {/* Body — single centered narrow column, generous vertical room.
          The category link lives in the breadcrumb above the hero now;
          the redundant overline-pill that used to sit here was removed. */}
      <section className="mx-auto max-w-[640px] px-5 pt-12 pb-32 md:px-8 md:pt-20 md:pb-24">
        {/* Title + price — generous spacing between, no horizontal rule. */}
        <header>
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

            {/* Shipping ETA — calm, factual answer to "if I order this,
                when does it arrive and how much shipping?" before the
                user is forced through checkout. Static copy by design;
                lives in i18n so operators can edit it. */}
            <p className="t-caption text-muted mt-8">{shippingEtaLabel}</p>

            {/* Inline de-risking line — sits between variants and the CTA so
                the reassurance lands at the moment of decision. Outside the
                sticky CTA wrapper so it doesn't pin to the viewport on mobile. */}
            <p className="t-caption text-faint mt-3">
              {contactInlineText}{" "}
              <a
                href={contactHref}
                className="text-faint hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
              >
                {contactInlineCta}
              </a>
            </p>

            <div
              className="border-line bg-cream sticky bottom-0 -mx-5 mt-6 border-t px-5 py-4 md:static md:m-0 md:mt-10 md:border-0 md:bg-transparent md:p-0"
              // env(safe-area-inset-bottom) keeps the sticky CTA above the
              // iPhone home indicator on mobile. The 1rem (16px) constant
              // matches the existing py-4 padding so the visual height
              // doesn't change on devices without an inset.
              style={{
                paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
              }}
            >
              {/* Quantity stepper. Sits above the CTA on mobile (stacked)
                  and to the left of it on desktop (`md:flex` row). */}
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
                <div className="flex items-center">
                  <span id="qty-label" className="sr-only">
                    {quantityLabel}
                  </span>
                  <div
                    role="group"
                    aria-labelledby="qty-label"
                    className="border-line flex h-12 w-32 shrink-0 items-center border"
                  >
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      disabled={quantity <= 1 || !firstVariant.available}
                      aria-label={quantityDecreaseLabel}
                      className="t-body text-fg hover:text-accent disabled:text-faint flex h-full w-10 shrink-0 items-center justify-center transition-colors duration-150 disabled:cursor-not-allowed"
                    >
                      &minus;
                    </button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={QUANTITY_MAX}
                      value={quantity}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        if (Number.isNaN(next)) {
                          setQuantity(1);
                          return;
                        }
                        setQuantity(Math.min(QUANTITY_MAX, Math.max(1, next)));
                      }}
                      aria-label={quantityLabel}
                      className="price-figure t-body text-fg flex-1 [appearance:textfield] bg-transparent text-center outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setQuantity((q) => Math.min(QUANTITY_MAX, q + 1))
                      }
                      disabled={
                        quantity >= QUANTITY_MAX || !firstVariant.available
                      }
                      aria-label={quantityIncreaseLabel}
                      className="t-body text-fg hover:text-accent disabled:text-faint flex h-full w-10 shrink-0 items-center justify-center transition-colors duration-150 disabled:cursor-not-allowed"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="flex-1">
                  <AddToCartButton
                    productId={product.id}
                    variantId={firstVariant.id}
                    productTitle={product.title}
                    productImageUrl={product.imageUrl}
                    productImageAlt={altText}
                    label={addToCartLabel}
                    soldOutLabel={outOfStockLabel}
                    addedLabel={addedLabel}
                    errorLabel={cartErrorLabel}
                    soldOut={!firstVariant.available}
                    quantity={quantity}
                    onAdded={() => setQuantity(1)}
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Related products. Quietly hidden when there are none. */}
      {related.length > 0 && (
        <section className="mx-auto max-w-[1280px] px-5 pb-32 md:px-8 md:pb-40">
          <p className="t-overline text-muted">{relatedTitle}</p>
          <div className="mt-10 grid grid-cols-2 gap-x-5 gap-y-12 md:mt-14 md:grid-cols-3 md:gap-x-8 md:gap-y-16 lg:grid-cols-4 lg:gap-x-8 lg:gap-y-20">
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

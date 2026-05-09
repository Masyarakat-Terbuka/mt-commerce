/**
 * CartPage — full-page cart island.
 *
 * Same data as `CartDrawer` with more breathing room. Two-column on desktop:
 * line items on the left, totals + checkout CTA on the right. Stacks on
 * mobile. Edit quantity inline; remove items via a quiet text button.
 */
import { useEffect, useMemo, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import {
  CART_CHANGED_EVENT_NAME,
  CartProvider,
  useCart,
  type CartChangedDetail,
} from "./CartProvider.js";
import {
  getProductInfo,
  PRODUCT_INFO_CHANGED_EVENT,
  type ProductInfo,
} from "../lib/cart-product-info.js";

export type CartPageProps = {
  locale: string;
  productsHref: string;
  checkoutHref: string;
  // i18n labels
  titleLabel: string;
  emptyLabel: string;
  emptyCtaLabel: string;
  /**
   * Renders the tax-inclusive items line (subtotal + tax). Indonesian
   * retail conventionally shows tax-inclusive prices for the items
   * themselves; the explicit tax line is dropped to keep the summary
   * compact, with the rate echoed inline as a "termasuk PPN 11%" note.
   */
  subtotalIncludingTaxLabel: string;
  /** Inline note after the tax-inclusive subtotal (e.g. "termasuk PPN"). */
  taxIncludedNote: string;
  shippingLabel: string;
  totalLabel: string;
  checkoutCtaLabel: string;
  removeLabel: string;
  quantityLabel: string;
  /**
   * Fallback line label when no product info is cached for a variant
   * (e.g. a cart restored from a previous session before the cache was
   * populated). Surfaces "Produk" / "Product" in place of the raw
   * variant id; the id is still rendered as small caption metadata.
   */
  productFallbackLabel: string;
};

function CartPageInner(props: CartPageProps) {
  const {
    locale,
    productsHref,
    checkoutHref,
    titleLabel,
    emptyLabel,
    emptyCtaLabel,
    subtotalIncludingTaxLabel,
    taxIncludedNote,
    shippingLabel,
    totalLabel,
    checkoutCtaLabel,
    removeLabel,
    quantityLabel,
    productFallbackLabel,
  } = props;
  const { cart, loading, updateItem, removeItem } = useCart();
  // Product info isn't carried on the cart wire shape yet; we resolve
  // {title, imageUrl} from a localStorage cache populated at add-time
  // by `cart-product-info`. `infoTick` bumps on `mt:variant-info-changed`
  // so freshly added lines pick up their entry without remounting.
  const [infoTick, setInfoTick] = useState(0);
  useEffect(() => {
    function onInfo() {
      setInfoTick((n) => n + 1);
    }
    window.addEventListener(PRODUCT_INFO_CHANGED_EVENT, onInfo);
    return () => window.removeEventListener(PRODUCT_INFO_CHANGED_EVENT, onInfo);
  }, []);

  // Mirrors CartDrawer: the most recently added variant id, used to flash
  // a brief tint on the matching line so the eye finds it. Scroll-into-view
  // and focus shift are intentionally omitted — the page is reached by
  // navigation (user lands at the top), and yanking the viewport down would
  // disorient more than help. The drawer doesn't scroll either.
  const [highlightedVariantId, setHighlightedVariantId] = useState<
    string | null
  >(null);

  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent<CartChangedDetail>).detail;
      if (!detail || detail.delta <= 0 || !detail.variantId) return;
      setHighlightedVariantId(detail.variantId);
    }
    window.addEventListener(CART_CHANGED_EVENT_NAME, onChange);
    return () => window.removeEventListener(CART_CHANGED_EVENT_NAME, onChange);
  }, []);

  useEffect(() => {
    if (!highlightedVariantId) return;
    const t = window.setTimeout(() => setHighlightedVariantId(null), 1500);
    return () => window.clearTimeout(t);
  }, [highlightedVariantId]);

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  // Resolve cached product info for every visible line. The lookup is
  // synchronous (localStorage) and the cart has at most a handful of
  // lines, so a per-render map is the right shape. Computed before the
  // skeleton early-return so the hook order stays stable across renders.
  const itemInfo = useMemo(() => {
    const map = new Map<string, ProductInfo | null>();
    for (const item of items)
      map.set(item.variantId, getProductInfo(item.variantId));
    return map;
    // `infoTick` invalidates the map when an add writes a new entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, infoTick]);

  if (loading && !cart) {
    // Quiet skeleton matches the rest of the storefront's loading states.
    return (
      <div
        className="mx-auto max-w-[1100px] px-5 py-16 md:px-8 md:py-24"
        aria-busy="true"
      >
        <div className="skeleton h-9 w-48" />
        <div className="skeleton mt-10 h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-32 md:px-8 md:pt-24">
      <header className="mb-12 md:mb-16">
        <h1 className="t-display text-fg">{titleLabel}</h1>
      </header>

      {isEmpty ? (
        <section className="py-16">
          <p className="t-body text-muted">{emptyLabel}</p>
          <a
            href={productsHref}
            className="t-body text-fg hover:text-accent mt-4 inline-flex underline-offset-[6px] transition-colors duration-150 hover:underline"
          >
            {emptyCtaLabel} &rarr;
          </a>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-12 md:grid-cols-[1fr_320px] md:gap-16">
          <ul className="divide-line divide-y">
            {items.map((item) => {
              const info = itemInfo.get(item.variantId) ?? null;
              const lineTitle = info?.title ?? productFallbackLabel;
              const lineAlt = info?.imageAlt ?? lineTitle;
              const isHighlighted = item.variantId === highlightedVariantId;
              return (
                <li
                  key={item.id}
                  // Highlight matches CartDrawer: a calm cream-deepened tint
                  // with a small horizontal bleed so the row reads as lifted.
                  // Animating only `background-color` keeps to the brand's
                  // "no transition: all" rule.
                  className={
                    isHighlighted
                      ? "bg-line/50 -mx-3 flex items-start gap-5 rounded-sm px-3 py-6 transition-colors duration-300 first:pt-6"
                      : "flex items-start gap-5 py-6 transition-colors duration-300 first:pt-0"
                  }
                >
                  {info?.imageUrl ? (
                    <img
                      src={info.imageUrl}
                      alt={lineAlt}
                      loading="lazy"
                      decoding="async"
                      className="bg-line h-20 w-20 shrink-0 object-cover"
                    />
                  ) : (
                    <div
                      className="bg-line h-20 w-20 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <div className="flex-1 space-y-2">
                    <p className="t-body text-fg">{lineTitle}</p>
                    {!info && (
                      // Fallback row: the cache had no entry for this
                      // variant (cart restored from before the cache
                      // was populated). Surface the variant id as
                      // small caption metadata rather than the title.
                      <p className="t-caption text-faint break-all">
                        {item.variantId}
                      </p>
                    )}
                    <p className="t-caption text-muted price-figure">
                      {formatMoney(item.unitPrice, { locale })}
                    </p>
                    <div className="flex items-center gap-4 pt-2">
                      <label
                        className="sr-only"
                        htmlFor={`cart-qty-${item.id}`}
                      >
                        {quantityLabel}
                      </label>
                      <input
                        id={`cart-qty-${item.id}`}
                        type="number"
                        min={0}
                        value={item.quantity}
                        onChange={(e) => {
                          const next = Math.max(
                            0,
                            Number.parseInt(e.target.value, 10) || 0,
                          );
                          void updateItem(item.id, next);
                        }}
                        className="border-line t-body text-fg focus:border-fg h-9 w-16 border bg-transparent px-2 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void removeItem(item.id)}
                        className="t-caption text-muted hover:text-accent underline-offset-[4px] transition-colors duration-150 hover:underline"
                      >
                        {removeLabel}
                      </button>
                    </div>
                  </div>
                  <p className="price-figure t-body text-fg">
                    {formatMoney(item.lineTotal, { locale })}
                  </p>
                </li>
              );
            })}
          </ul>

          <aside className="border-line border-t pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
            <dl className="t-body space-y-3">
              <div className="text-muted flex justify-between">
                <dt className="flex flex-col">
                  <span>{subtotalIncludingTaxLabel}</span>
                  {/*
                   * Render the basis-points value as a percent (1100 → "11%")
                   * when a rate is configured. Falls back to the generic
                   * note when the rate is unknown (env-var fallback path).
                   */}
                  <span className="t-caption text-muted/70">
                    {cart && cart.totals.taxRateBasisPoints !== null
                      ? `${taxIncludedNote} ${cart.totals.taxRateBasisPoints / 100}%`
                      : taxIncludedNote}
                  </span>
                </dt>
                <dd className="price-figure">
                  {cart &&
                    formatMoney(cart.totals.subtotalIncludingTax, { locale })}
                </dd>
              </div>
              <div className="text-muted flex justify-between">
                <dt>{shippingLabel}</dt>
                <dd className="price-figure">
                  {cart && formatMoney(cart.totals.shipping, { locale })}
                </dd>
              </div>
              <div className="border-line text-fg flex justify-between border-t pt-4">
                <dt>{totalLabel}</dt>
                <dd className="price-figure">
                  {cart && formatMoney(cart.totals.total, { locale })}
                </dd>
              </div>
            </dl>
            <a href={checkoutHref} className="btn-primary mt-6 w-full">
              {checkoutCtaLabel}
            </a>
          </aside>
        </div>
      )}
    </div>
  );
}

export default function CartPage(props: CartPageProps) {
  return (
    <CartProvider>
      <CartPageInner {...props} />
    </CartProvider>
  );
}

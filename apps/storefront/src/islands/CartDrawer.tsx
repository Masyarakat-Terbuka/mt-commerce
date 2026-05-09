/**
 * CartDrawer — slide-in panel that mirrors `useCart()` state.
 *
 * Visibility:
 *   - Always mounted (so a CSS `transform` transition can animate the
 *     slide). The `data-state="open|closed"` attribute on the panel drives
 *     the visual state via `global.css`. A backdrop and the panel both
 *     toggle in sync.
 *   - Listens for the `mt:cart-open` window event (dispatched by
 *     AddToCartButton on success) to slide in. Stays open until the user
 *     dismisses it via Escape, backdrop click, or the in-panel close
 *     button — there is no auto-close timer.
 *
 * Accessibility:
 *   - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the
 *     panel title.
 *   - Focus trap: on open, focus moves to the close button. Tab/Shift+Tab
 *     cycles within the dialog.
 *   - Escape closes. Body scroll is locked while open; restored on close.
 *   - `aria-hidden="true"` flips on the panel when closed so screen
 *     readers don't surface the drawer's content while it's offscreen.
 *   - `inert` is set on the panel when closed so it cannot receive focus
 *     either (Tab from the page chrome doesn't fall into the closed drawer).
 *   - `overscroll-behavior: contain` on the panel so dragging at the
 *     bottom of a long line-item list doesn't bounce-scroll the body.
 *
 * Layout:
 *   - Mobile: full-screen sheet (right edge slides to cover the viewport).
 *   - Desktop ≥768px: 480px-wide right rail with a translucent backdrop.
 *   - The panel carries a subtle shadow on desktop. The brand normally
 *     forbids drop shadows; the drawer is the only documented exception
 *     (it must lift off the page so the backdrop reads as a layer).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  CART_CHANGED_EVENT_NAME,
  CART_OPEN_EVENT_NAME,
  CartProvider,
  useCart,
  type CartChangedDetail,
} from "./CartProvider.js";
import {
  getProductInfo,
  PRODUCT_INFO_CHANGED_EVENT,
  type ProductInfo,
} from "../lib/cart-product-info.js";

export type CartDrawerProps = {
  /** BCP 47 locale for currency formatting (e.g. "id-ID"). */
  locale: string;
  /** Path to the full /cart page. */
  cartHref: string;
  /** Path to the /checkout page (placeholder route until checkout UI lands). */
  checkoutHref: string;
  /** Path to the products listing — empty-state CTA. */
  productsHref: string;
  // i18n labels
  titleLabel: string;
  closeLabel: string;
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

function CartDrawerInner(props: CartDrawerProps) {
  const {
    locale,
    cartHref,
    checkoutHref,
    productsHref,
    titleLabel,
    closeLabel,
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
  const [open, setOpen] = useState(false);
  // The most recently added variant id, used to highlight the matching
  // line item briefly. Cleared whenever the drawer closes.
  const [highlightedVariantId, setHighlightedVariantId] = useState<
    string | null
  >(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Listen for the open signal dispatched by AddToCartButton.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener(CART_OPEN_EVENT_NAME, onOpen);
    return () => window.removeEventListener(CART_OPEN_EVENT_NAME, onOpen);
  }, []);

  // Track the most recently added variant for the highlight stripe.
  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent<CartChangedDetail>).detail;
      if (!detail || detail.delta <= 0 || !detail.variantId) return;
      setHighlightedVariantId(detail.variantId);
    }
    window.addEventListener(CART_CHANGED_EVENT_NAME, onChange);
    return () => window.removeEventListener(CART_CHANGED_EVENT_NAME, onChange);
  }, []);

  // Fade the highlight after a short window so it doesn't linger.
  useEffect(() => {
    if (!highlightedVariantId) return;
    const t = window.setTimeout(() => setHighlightedVariantId(null), 1500);
    return () => window.clearTimeout(t);
  }, [highlightedVariantId]);

  // Focus management + body scroll lock + Escape-to-close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        // Naive but effective focus trap: collect focusables, cycle.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Close the drawer cleanup — also clears the highlight so the next open
  // doesn't flash a stale line.
  const close = useCallback(() => {
    setOpen(false);
    setHighlightedVariantId(null);
  }, []);

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  // Resolve cached product info for every visible line. The lookup is
  // synchronous (localStorage) and the cart has at most a handful of
  // lines, so a per-render map is the right shape.
  const itemInfo = useMemo(() => {
    const map = new Map<string, ProductInfo | null>();
    for (const item of items)
      map.set(item.variantId, getProductInfo(item.variantId));
    return map;
    // `infoTick` invalidates the map when an add writes a new entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, infoTick]);

  return (
    <div
      // Container is always in the DOM so the slide transition has
      // somewhere to animate. `pointer-events: none` when closed means
      // the page underneath is not blocked.
      className={
        open ? "fixed inset-0 z-50" : "pointer-events-none fixed inset-0 z-50"
      }
      aria-hidden={!open}
    >
      {/* Backdrop — translucent fg wash. Click closes. */}
      <div
        data-cart-drawer-backdrop
        className={
          open
            ? "bg-fg/35 absolute inset-0"
            : "bg-fg/35 absolute inset-0 opacity-0"
        }
        onClick={close}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        data-cart-drawer-panel
        data-state={open ? "open" : "closed"}
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-labelledby="cart-drawer-title"
        // `inert` keeps focus from falling into the closed drawer when a
        // user tabs through the page. (`inert` is the React 19 attribute
        // form; React passes it through to the DOM.)
        // @ts-expect-error — `inert` lands as a typed prop in @types/react 19.x; stay forward-compatible.
        inert={open ? undefined : ""}
        // overscroll-behavior keeps mobile bounce from leaking to the body
        // while the user scrolls a long item list.
        style={{ overscrollBehavior: "contain" }}
        className="border-line bg-cream absolute top-0 right-0 flex h-full w-full flex-col border-l shadow-[-12px_0_24px_-16px_rgba(26,26,26,0.18)] md:w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-line flex items-center justify-between border-b px-5 py-4 md:px-6">
          <h2 id="cart-drawer-title" className="t-h1 text-fg">
            {titleLabel}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label={closeLabel}
            className="text-fg hover:text-accent -mr-2 flex h-9 w-9 items-center justify-center transition-colors duration-150"
          >
            {/* Hugeicons Cancel01 — decorative; the button's aria-label
                describes the close action. */}
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={18}
              strokeWidth={1.5}
              aria-hidden
            />
          </button>
        </header>

        <div
          className="flex-1 overflow-y-auto px-5 py-6 md:px-6"
          aria-busy={loading}
        >
          {isEmpty ? (
            <div className="flex h-full flex-col items-start justify-center">
              <p className="t-body text-muted">{emptyLabel}</p>
              <a
                href={productsHref}
                className="t-body text-fg hover:text-accent mt-4 underline-offset-[6px] transition-colors duration-150 hover:underline"
              >
                {emptyCtaLabel} &rarr;
              </a>
            </div>
          ) : (
            <ul className="space-y-6">
              {items.map((item) => {
                const isHighlighted = item.variantId === highlightedVariantId;
                const info = itemInfo.get(item.variantId) ?? null;
                const lineTitle = info?.title ?? productFallbackLabel;
                const lineAlt = info?.imageAlt ?? lineTitle;
                return (
                  <li
                    key={item.id}
                    // The highlight is a calm cream-deepened tint via a
                    // negative-margin padded box; we animate `background-color`
                    // (a colour transition is permitted because it's the only
                    // property changing — no `transition: all`).
                    className={
                      isHighlighted
                        ? "bg-line/50 -mx-3 flex items-start gap-4 rounded-sm px-3 py-2 transition-colors duration-300"
                        : "flex items-start gap-4 transition-colors duration-300"
                    }
                  >
                    {info?.imageUrl ? (
                      <img
                        src={info.imageUrl}
                        alt={lineAlt}
                        loading="lazy"
                        decoding="async"
                        className="bg-line h-16 w-16 shrink-0 object-cover"
                      />
                    ) : (
                      <div
                        className="bg-line h-16 w-16 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <div className="flex-1 space-y-2">
                      <p className="t-body text-fg line-clamp-2">{lineTitle}</p>
                      {!info && (
                        // Fallback row: the cache had no entry for this
                        // variant (cart restored from before the cache
                        // was populated). Surface the variant id as
                        // small caption metadata rather than the title.
                        <p className="t-caption text-faint break-all">
                          {item.variantId}
                        </p>
                      )}
                      <div className="flex items-center gap-3">
                        <label className="sr-only" htmlFor={`qty-${item.id}`}>
                          {quantityLabel}
                        </label>
                        <input
                          id={`qty-${item.id}`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={item.quantity}
                          onChange={(e) => {
                            const next = Math.max(
                              0,
                              Number.parseInt(e.target.value, 10) || 0,
                            );
                            void updateItem(item.id, next);
                          }}
                          className="border-line t-body text-fg focus:border-fg h-8 w-14 border bg-transparent px-2 outline-none"
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
          )}
        </div>

        {!isEmpty && cart && (
          <footer
            className="border-line border-t px-5 py-5 md:px-6"
            // Sticky CTAs below an iPhone home indicator need the safe-area
            // inset; the drawer footer is one of those because the panel
            // covers the full viewport height on mobile.
            style={{
              paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <dl className="t-body space-y-2">
              <div className="text-muted flex justify-between">
                <dt className="flex flex-col">
                  <span>{subtotalIncludingTaxLabel}</span>
                  {/*
                   * When a rate is configured, render the basis-points value
                   * as a percent (1100 → "11%") so shoppers can see the rate
                   * inline. Falls back to the generic note when the rate is
                   * unknown (env-var fallback path).
                   */}
                  <span className="t-caption text-muted/70">
                    {cart.totals.taxRateBasisPoints !== null
                      ? `${taxIncludedNote} ${cart.totals.taxRateBasisPoints / 100}%`
                      : taxIncludedNote}
                  </span>
                </dt>
                <dd className="price-figure">
                  {formatMoney(cart.totals.subtotalIncludingTax, { locale })}
                </dd>
              </div>
              <div className="text-muted flex justify-between">
                <dt>{shippingLabel}</dt>
                <dd className="price-figure">
                  {formatMoney(cart.totals.shipping, { locale })}
                </dd>
              </div>
              <div className="border-line text-fg flex justify-between border-t pt-3">
                <dt>{totalLabel}</dt>
                <dd className="price-figure">
                  {formatMoney(cart.totals.total, { locale })}
                </dd>
              </div>
            </dl>
            <a href={checkoutHref} className="btn-primary mt-5 w-full">
              {checkoutCtaLabel}
            </a>
            <a
              href={cartHref}
              className="t-caption text-muted hover:text-accent mt-3 block text-center transition-colors duration-150"
            >
              {titleLabel} &rarr;
            </a>
          </footer>
        )}
      </div>
    </div>
  );
}

export default function CartDrawer(props: CartDrawerProps) {
  return (
    <CartProvider>
      <CartDrawerInner {...props} />
    </CartProvider>
  );
}

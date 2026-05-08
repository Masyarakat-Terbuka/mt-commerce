/**
 * CartDrawer — slide-in panel that mirrors `useCart()` state.
 *
 * Visibility:
 *   - Mounts hidden. Listens for the `mt:cart-open` window event (dispatched
 *     by AddToCartButton on success and by the header bag-link's data-attr
 *     handler) to slide in. Closes on Escape, on backdrop click, and on the
 *     in-panel close button.
 *
 * Accessibility:
 *   - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the
 *     panel title.
 *   - Focus trap: on open, focus moves to the close button. Tab/Shift+Tab
 *     cycles within the dialog.
 *   - Escape closes. Body scroll is locked while open; restored on close.
 *   - Empty/list/error states all live inside the dialog so a screen reader
 *     reads the new state when it opens.
 *
 * Layout:
 *   - Mobile: full-screen sheet (right edge slides to cover the viewport).
 *   - Desktop ≥768px: 480px-wide right rail with a translucent backdrop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  CART_OPEN_EVENT_NAME,
  CartProvider,
  useCart,
} from "./CartProvider.js";

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
  } = props;
  const { cart, loading, updateItem, removeItem } = useCart();
  const [open, setOpen] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Listen for the open signal dispatched by AddToCartButton (and the header's
  // bag-icon click handler attached in Header.astro).
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener(CART_OPEN_EVENT_NAME, onOpen);
    return () => window.removeEventListener(CART_OPEN_EVENT_NAME, onOpen);
  }, []);

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

  const close = useCallback(() => setOpen(false), []);

  if (!open) return null;

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  return (
    <div
      className="fixed inset-0 z-50"
      // Backdrop click closes; the panel below stops propagation.
      onClick={close}
    >
      {/* Backdrop — translucent cream wash, matches site palette. */}
      <div className="absolute inset-0 bg-fg/35" aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        className="absolute right-0 top-0 flex h-full w-full flex-col border-l border-line bg-cream md:w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4 md:px-6">
          <h2 id="cart-drawer-title" className="t-h1 text-fg">
            {titleLabel}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label={closeLabel}
            className="-mr-2 flex h-9 w-9 items-center justify-center text-fg transition-colors duration-150 hover:text-accent"
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

        <div className="flex-1 overflow-y-auto px-5 py-6 md:px-6" aria-busy={loading}>
          {isEmpty ? (
            <div className="flex h-full flex-col items-start justify-center">
              <p className="t-body text-muted">{emptyLabel}</p>
              <a
                href={productsHref}
                className="mt-4 t-body text-fg underline-offset-[6px] transition-colors duration-150 hover:text-accent hover:underline"
              >
                {emptyCtaLabel} &rarr;
              </a>
            </div>
          ) : (
            <ul className="space-y-6">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-4">
                  {/* Image placeholder; the cart item DTO doesn't carry the
                      product image yet. The drawer keeps a calm cream square so
                      the layout doesn't reflow when an image lands later. */}
                  <div className="h-16 w-16 shrink-0 bg-line" aria-hidden="true" />
                  <div className="flex-1 space-y-2">
                    <p className="t-body text-fg">{item.variantId}</p>
                    <div className="flex items-center gap-3">
                      <label className="sr-only" htmlFor={`qty-${item.id}`}>
                        {quantityLabel}
                      </label>
                      <input
                        id={`qty-${item.id}`}
                        type="number"
                        min={0}
                        value={item.quantity}
                        onChange={(e) => {
                          const next = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                          void updateItem(item.id, next);
                        }}
                        className="h-8 w-14 border border-line bg-transparent px-2 t-body text-fg outline-none focus:border-fg"
                      />
                      <button
                        type="button"
                        onClick={() => void removeItem(item.id)}
                        className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
                      >
                        {removeLabel}
                      </button>
                    </div>
                  </div>
                  <p className="price-figure t-body text-fg">
                    {formatMoney(item.lineTotal, { locale })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!isEmpty && cart && (
          <footer className="border-t border-line px-5 py-5 md:px-6">
            <dl className="space-y-2 t-body">
              <div className="flex justify-between text-muted">
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
              <div className="flex justify-between text-muted">
                <dt>{shippingLabel}</dt>
                <dd className="price-figure">
                  {formatMoney(cart.totals.shipping, { locale })}
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-3 text-fg">
                <dt>{totalLabel}</dt>
                <dd className="price-figure">
                  {formatMoney(cart.totals.total, { locale })}
                </dd>
              </div>
            </dl>
            <a
              href={checkoutHref}
              className="btn-primary mt-5 w-full"
            >
              {checkoutCtaLabel}
            </a>
            <a
              href={cartHref}
              className="mt-3 block text-center t-caption text-muted transition-colors duration-150 hover:text-accent"
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

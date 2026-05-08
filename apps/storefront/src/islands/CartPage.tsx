/**
 * CartPage — full-page cart island.
 *
 * Same data as `CartDrawer` with more breathing room. Two-column on desktop:
 * line items on the left, totals + checkout CTA on the right. Stacks on
 * mobile. Edit quantity inline; remove items via a quiet text button.
 */
import { format as formatMoney } from "@mt-commerce/core/money";
import { CartProvider, useCart } from "./CartProvider.js";

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
  } = props;
  const { cart, loading, updateItem, removeItem } = useCart();

  if (loading && !cart) {
    // Quiet skeleton matches the rest of the storefront's loading states.
    return (
      <div className="mx-auto max-w-[1100px] px-5 py-16 md:px-8 md:py-24" aria-busy="true">
        <div className="h-9 w-48 skeleton" />
        <div className="mt-10 h-32 w-full skeleton" />
      </div>
    );
  }

  const items = cart?.items ?? [];
  const isEmpty = items.length === 0;

  return (
    <div className="mx-auto max-w-[1100px] px-5 pb-32 pt-16 md:px-8 md:pt-24">
      <header className="mb-12 md:mb-16">
        <h1 className="t-display text-fg">{titleLabel}</h1>
      </header>

      {isEmpty ? (
        <section className="py-16">
          <p className="t-body text-muted">{emptyLabel}</p>
          <a
            href={productsHref}
            className="mt-4 inline-flex t-body text-fg underline-offset-[6px] transition-colors duration-150 hover:text-accent hover:underline"
          >
            {emptyCtaLabel} &rarr;
          </a>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-12 md:grid-cols-[1fr_320px] md:gap-16">
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-5 py-6 first:pt-0">
                <div className="h-20 w-20 shrink-0 bg-line" aria-hidden="true" />
                <div className="flex-1 space-y-2">
                  <p className="t-body text-fg">{item.variantId}</p>
                  <p className="t-caption text-muted price-figure">
                    {formatMoney(item.unitPrice, { locale })}
                  </p>
                  <div className="flex items-center gap-4 pt-2">
                    <label className="sr-only" htmlFor={`cart-qty-${item.id}`}>
                      {quantityLabel}
                    </label>
                    <input
                      id={`cart-qty-${item.id}`}
                      type="number"
                      min={0}
                      value={item.quantity}
                      onChange={(e) => {
                        const next = Math.max(0, Number.parseInt(e.target.value, 10) || 0);
                        void updateItem(item.id, next);
                      }}
                      className="h-9 w-16 border border-line bg-transparent px-2 t-body text-fg outline-none focus:border-fg"
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

          <aside className="border-t border-line pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0">
            <dl className="space-y-3 t-body">
              <div className="flex justify-between text-muted">
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
                  {cart && formatMoney(cart.totals.subtotalIncludingTax, { locale })}
                </dd>
              </div>
              <div className="flex justify-between text-muted">
                <dt>{shippingLabel}</dt>
                <dd className="price-figure">
                  {cart && formatMoney(cart.totals.shipping, { locale })}
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-4 text-fg">
                <dt>{totalLabel}</dt>
                <dd className="price-figure">
                  {cart && formatMoney(cart.totals.total, { locale })}
                </dd>
              </div>
            </dl>
            <a
              href={checkoutHref}
              className="btn-primary mt-6 w-full"
            >
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

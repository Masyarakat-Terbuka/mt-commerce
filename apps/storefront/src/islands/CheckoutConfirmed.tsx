/**
 * CheckoutConfirmed — confirmation island rendered at /checkout/[id]/confirmed.
 *
 * Data model: the checkout flow stores the order intent payload in
 * `sessionStorage` keyed by `mt.orderIntent.<id>` immediately after a
 * successful `complete` call. We rehydrate from there rather than
 * round-tripping back through the API:
 *
 *   - The order intent only exists for the duration of the post-checkout
 *     navigation; sessionStorage scopes it cleanly to the tab.
 *   - The flow island already had the data in hand — re-fetching here would
 *     just duplicate work.
 *
 * If the storage entry is missing (the user reloads the URL hours later, or
 * landed via direct link), we render a calm fallback that surfaces the order
 * id but no totals — better than crashing.
 */
import { useEffect, useMemo, useState } from "react";
import { format as formatMoney, type Money } from "@mt-commerce/core/money";
import {
  getProductInfo,
  PRODUCT_INFO_CHANGED_EVENT,
  type ProductInfo,
} from "../lib/cart-product-info.js";

const ORDER_INTENT_STORAGE_PREFIX = "mt.orderIntent.";

interface SerializedMoney {
  amount: string;
  currency: string;
}

interface SerializedAddress {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
}

interface SerializedOrderIntent {
  id: string;
  email: string;
  shippingMethodCode: string;
  paymentMethod: string;
  cartSnapshot: Array<{
    variantId: string;
    quantity: number;
    unitPrice: SerializedMoney;
  }>;
  totalsSnapshot: {
    subtotal: SerializedMoney;
    tax: SerializedMoney;
    shipping: SerializedMoney;
    total: SerializedMoney;
  };
  shippingAddressSnapshot: SerializedAddress | null;
  billingAddressSnapshot: SerializedAddress | null;
}

interface SerializedHandoff {
  checkoutId: string;
  orderIntent: SerializedOrderIntent;
}

function deserializeMoney(money: SerializedMoney): Money {
  return { amount: BigInt(money.amount), currency: money.currency };
}

function readHandoff(orderIntentId: string): SerializedHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      `${ORDER_INTENT_STORAGE_PREFIX}${orderIntentId}`,
    );
    if (!raw) return null;
    return JSON.parse(raw) as SerializedHandoff;
  } catch {
    return null;
  }
}

export type CheckoutConfirmedProps = {
  orderIntentId: string;
  locale: string;
  homeHref: string;
  // i18n labels — passed in as props so the island stays locale-agnostic.
  titleLabel: string;
  subtitleLabel: string;
  orderNumberLabel: string;
  nextStepsLabel: string;
  backHomeLabel: string;
  missingLabel: string;
  itemsLabel: string;
  addressLabel: string;
  /**
   * Fallback label for cart lines when no product info is cached for a
   * variant (e.g. the cache was cleared between order placement and a
   * later visit to this page). Surfaces "Produk" / "Product" instead of
   * a raw variant id.
   */
  productFallbackLabel: string;
  totalsLabels: {
    subtotal: string;
    tax: string;
    shipping: string;
    total: string;
  };
};

export default function CheckoutConfirmed(props: CheckoutConfirmedProps) {
  const {
    orderIntentId,
    locale,
    homeHref,
    titleLabel,
    subtitleLabel,
    orderNumberLabel,
    nextStepsLabel,
    backHomeLabel,
    missingLabel,
    itemsLabel,
    addressLabel,
    productFallbackLabel,
    totalsLabels,
  } = props;

  const [handoff, setHandoff] = useState<SerializedHandoff | null>(null);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    // localStorage hydration must happen client-side; lazy useState
    // init runs server-side too. Synchronous setState on first commit
    // is the SSR-safe pattern Astro islands use.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHandoff(readHandoff(orderIntentId));
    setHydrated(true);
  }, [orderIntentId]);

  const orderIntent = handoff?.orderIntent ?? null;

  // Resolve cached product info for each line so the receipt shows real
  // titles instead of raw variant ids. The cache survives the navigation
  // from /checkout (it's localStorage, not session-bound), so a freshly
  // placed order's lines should hit. Lines without a cache entry fall
  // back to the generic "Produk" / "Product" label.
  const [infoTick, setInfoTick] = useState(0);
  useEffect(() => {
    function onInfo() {
      setInfoTick((n) => n + 1);
    }
    window.addEventListener(PRODUCT_INFO_CHANGED_EVENT, onInfo);
    return () => window.removeEventListener(PRODUCT_INFO_CHANGED_EVENT, onInfo);
  }, []);
  const itemInfo = useMemo(() => {
    const map = new Map<string, ProductInfo | null>();
    if (orderIntent) {
      for (const line of orderIntent.cartSnapshot)
        map.set(line.variantId, getProductInfo(line.variantId));
    }
    return map;
    // `infoTick` invalidates the map when a new cache entry lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderIntent, infoTick]);

  const totals = useMemo(() => {
    if (!orderIntent) return null;
    return {
      subtotal: deserializeMoney(orderIntent.totalsSnapshot.subtotal),
      tax: deserializeMoney(orderIntent.totalsSnapshot.tax),
      shipping: deserializeMoney(orderIntent.totalsSnapshot.shipping),
      total: deserializeMoney(orderIntent.totalsSnapshot.total),
    };
  }, [orderIntent]);

  return (
    <div className="mx-auto max-w-[760px] px-5 pt-16 pb-32 md:px-8 md:pt-24">
      <h1 className="t-display text-fg">{titleLabel}</h1>
      <p className="t-body text-muted mt-4">{subtitleLabel}</p>

      <dl className="border-line mt-12 border-y py-6">
        <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-8">
          <dt className="t-caption text-muted">{orderNumberLabel}</dt>
          <dd className="t-h1 text-fg">{orderIntentId}</dd>
        </div>
      </dl>

      {hydrated && !orderIntent ? (
        <p className="t-body text-muted mt-12">{missingLabel}</p>
      ) : orderIntent && totals ? (
        <>
          <section className="mt-12">
            <h2 className="t-caption text-muted">{itemsLabel}</h2>
            <ul className="divide-line mt-4 divide-y">
              {orderIntent.cartSnapshot.map((line) => {
                const info = itemInfo.get(line.variantId) ?? null;
                const lineTitle = info?.title ?? productFallbackLabel;
                return (
                  <li
                    key={`${line.variantId}-${line.quantity}`}
                    className="flex items-start justify-between gap-4 py-4"
                  >
                    <div>
                      <p className="t-body text-fg">{lineTitle}</p>
                      <p className="t-caption text-muted">× {line.quantity}</p>
                    </div>
                    <p className="price-figure t-body text-fg">
                      {formatMoney(deserializeMoney(line.unitPrice), {
                        locale,
                      })}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>

          {orderIntent.shippingAddressSnapshot && (
            <section className="mt-10">
              <h2 className="t-caption text-muted">{addressLabel}</h2>
              <div className="mt-3 space-y-1">
                <p className="t-body text-fg">
                  {orderIntent.shippingAddressSnapshot.recipientName}
                </p>
                <p className="t-caption text-muted">
                  {[
                    orderIntent.shippingAddressSnapshot.addressLine1,
                    orderIntent.shippingAddressSnapshot.addressLine2,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <p className="t-caption text-faint">
                  {orderIntent.shippingAddressSnapshot.phone}
                </p>
              </div>
            </section>
          )}

          <dl className="border-line t-body mt-10 space-y-2 border-t pt-6">
            <div className="text-muted flex justify-between">
              <dt>{totalsLabels.subtotal}</dt>
              <dd className="price-figure">
                {formatMoney(totals.subtotal, { locale })}
              </dd>
            </div>
            <div className="text-muted flex justify-between">
              <dt>{totalsLabels.tax}</dt>
              <dd className="price-figure">
                {formatMoney(totals.tax, { locale })}
              </dd>
            </div>
            <div className="text-muted flex justify-between">
              <dt>{totalsLabels.shipping}</dt>
              <dd className="price-figure">
                {formatMoney(totals.shipping, { locale })}
              </dd>
            </div>
            <div className="border-line text-fg flex justify-between border-t pt-3">
              <dt>{totalsLabels.total}</dt>
              <dd className="price-figure">
                {formatMoney(totals.total, { locale })}
              </dd>
            </div>
          </dl>
        </>
      ) : null}

      <p className="t-body text-muted mt-12">{nextStepsLabel}</p>

      <a
        href={homeHref}
        className="t-body text-fg hover:text-accent mt-10 inline-flex underline-offset-[6px] transition-colors duration-150 hover:underline"
      >
        {backHomeLabel} &rarr;
      </a>
    </div>
  );
}

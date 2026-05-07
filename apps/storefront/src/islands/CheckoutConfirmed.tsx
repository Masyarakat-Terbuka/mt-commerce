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
    totalsLabels,
  } = props;

  const [handoff, setHandoff] = useState<SerializedHandoff | null>(null);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    setHandoff(readHandoff(orderIntentId));
    setHydrated(true);
  }, [orderIntentId]);

  const orderIntent = handoff?.orderIntent ?? null;

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
    <div className="mx-auto max-w-[760px] px-5 pb-32 pt-16 md:px-8 md:pt-24">
      <h1 className="t-display text-fg">{titleLabel}</h1>
      <p className="mt-4 t-body text-muted">{subtitleLabel}</p>

      <dl className="mt-12 border-y border-line py-6">
        <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:justify-between md:gap-8">
          <dt className="t-caption text-muted">{orderNumberLabel}</dt>
          <dd className="t-h1 text-fg">{orderIntentId}</dd>
        </div>
      </dl>

      {hydrated && !orderIntent ? (
        <p className="mt-12 t-body text-muted">{missingLabel}</p>
      ) : orderIntent && totals ? (
        <>
          <section className="mt-12">
            <h2 className="t-caption text-muted">{itemsLabel}</h2>
            <ul className="mt-4 divide-y divide-line">
              {orderIntent.cartSnapshot.map((line) => (
                <li
                  key={`${line.variantId}-${line.quantity}`}
                  className="flex items-start justify-between gap-4 py-4"
                >
                  <div>
                    <p className="t-body text-fg">{line.variantId}</p>
                    <p className="t-caption text-muted">× {line.quantity}</p>
                  </div>
                  <p className="price-figure t-body text-fg">
                    {formatMoney(deserializeMoney(line.unitPrice), { locale })}
                  </p>
                </li>
              ))}
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

          <dl className="mt-10 space-y-2 border-t border-line pt-6 t-body">
            <div className="flex justify-between text-muted">
              <dt>{totalsLabels.subtotal}</dt>
              <dd className="price-figure">{formatMoney(totals.subtotal, { locale })}</dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>{totalsLabels.tax}</dt>
              <dd className="price-figure">{formatMoney(totals.tax, { locale })}</dd>
            </div>
            <div className="flex justify-between text-muted">
              <dt>{totalsLabels.shipping}</dt>
              <dd className="price-figure">{formatMoney(totals.shipping, { locale })}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-3 text-fg">
              <dt>{totalsLabels.total}</dt>
              <dd className="price-figure">{formatMoney(totals.total, { locale })}</dd>
            </div>
          </dl>
        </>
      ) : null}

      <p className="mt-12 t-body text-muted">{nextStepsLabel}</p>

      <a
        href={homeHref}
        className="mt-10 inline-flex t-body text-fg underline-offset-[6px] transition-colors duration-150 hover:text-accent hover:underline"
      >
        {backHomeLabel} &rarr;
      </a>
    </div>
  );
}

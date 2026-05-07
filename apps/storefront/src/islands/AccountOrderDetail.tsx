/**
 * AccountOrderDetail — single-order detail view rendered inside `/account`.
 *
 * Why a query-param route instead of a dynamic segment:
 *
 *   The storefront builds with `output: "static"` (ADR-0006). Dynamic Astro
 *   segments need `getStaticPaths` to enumerate every path at build time —
 *   which we cannot do for an unbounded set of customer orders. Following
 *   the same pattern as the checkout-confirmation page, the route is a
 *   static URL and the order is identified by a query parameter
 *   (`?o=<orderNumber>`). The `<a href>` we emit on the orders list links
 *   here.
 *
 * Auth + ownership:
 *
 *   The auth gate is the same as every other account island. Cross-tenant
 *   safety lives on the server: the API surfaces "not yours" as 404, so we
 *   render the not-found copy without leaking existence.
 *
 * Money + dates use the platform's existing helpers; status strings come
 * from the parent so the island stays locale-independent.
 */
import { useEffect, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import {
  ApiError,
  createClient,
  type Order,
  type OrderAddressSnapshot,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";

export interface AccountOrderDetailLabels {
  titlePattern: string; // "Pesanan {number}" / "Order {number}"
  back: string;
  placedOn: string;
  statusLabel: string;
  shippingAddress: string;
  billingAddress: string;
  items: string;
  paymentMethod: string;
  shippingMethod: string;
  totals: string;
  contact: string;
  contactLink: string;
  notFound: string;
  error: string;
  loading: string;
  totalsSubtotal: string;
  totalsTax: string;
  totalsShipping: string;
  totalsTotal: string;
  status: Record<Order["status"], string>;
}

export interface AccountOrderDetailProps {
  locale: string;
  apiLocale: "id" | "en";
  signInHref: string;
  currentPath: string;
  /** Link back to `/account/orders`. */
  ordersHref: string;
  /** Path the "contact us" link points to (`/help/contact` placeholder). */
  contactHref: string;
  labels: AccountOrderDetailLabels;
}

type Phase = "loading" | "ready" | "redirecting" | "not_found" | "error";

function readOrderNumberParam(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URL(window.location.href).searchParams.get("o");
  return value && value.trim().length > 0 ? value.trim() : null;
}

function AddressBlock({
  title,
  address,
}: {
  title: string;
  address: OrderAddressSnapshot;
}) {
  return (
    <div className="border border-line bg-paper p-5">
      <h3 className="t-caption text-muted">{title}</h3>
      <div className="mt-3 space-y-1">
        <p className="t-body text-fg">{address.recipientName}</p>
        <p className="t-caption text-muted">
          {[address.addressLine1, address.addressLine2]
            .filter(Boolean)
            .join(", ")}
        </p>
        <p className="t-caption text-muted">
          {address.kotaKabupatenId} · {address.postalCode}
        </p>
        <p className="t-caption text-faint">{address.phone}</p>
      </div>
    </div>
  );
}

export default function AccountOrderDetail({
  locale,
  apiLocale,
  signInHref,
  currentPath,
  ordersHref,
  contactHref,
  labels,
}: AccountOrderDetailProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orderNumber = readOrderNumberParam();
      if (!orderNumber) {
        setPhase("not_found");
        return;
      }
      try {
        const me = await refreshAccount();
        if (cancelled) return;
        if (!me.user) {
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        if (!me.customer?.id) {
          setPhase("not_found");
          return;
        }
        const client = createClient({
          baseUrl: resolveApiUrl(),
          locale: apiLocale,
        });
        const fetched = await client.storefront.customer.orders.byNumber(
          orderNumber,
          { customerId: me.customer.id, locale: apiLocale },
        );
        if (cancelled) return;
        setOrder(fetched);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          writeCachedCustomerId(null);
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setPhase("not_found");
          return;
        }
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiLocale, currentPath, signInHref]);

  if (phase === "loading" || phase === "redirecting") {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="h-9 w-72 skeleton" />
        <div className="h-32 w-full skeleton" />
        <div className="h-48 w-full skeleton" />
      </div>
    );
  }

  if (phase === "not_found") {
    return (
      <div className="space-y-6">
        <a
          href={ordersHref}
          className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
        >
          &larr; {labels.back}
        </a>
        <p className="t-body text-muted">{labels.notFound}</p>
      </div>
    );
  }

  if (phase === "error" || !order) {
    return (
      <div className="space-y-6">
        <a
          href={ordersHref}
          className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
        >
          &larr; {labels.back}
        </a>
        <p role="alert" className="t-body text-danger">
          {labels.error}
        </p>
      </div>
    );
  }

  const placedOn = new Date(order.createdAt).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const heading = labels.titlePattern.replace("{number}", order.orderNumber);

  return (
    <div className="space-y-10">
      <a
        href={ordersHref}
        className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
      >
        &larr; {labels.back}
      </a>

      <header className="space-y-2">
        <h1 className="t-display text-fg">{heading}</h1>
        <p className="t-body text-muted">
          {labels.placedOn}: {placedOn}
        </p>
        <p className="t-caption text-muted">
          {labels.statusLabel}: {labels.status[order.status]}
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <AddressBlock
          title={labels.shippingAddress}
          address={order.shippingAddressSnapshot}
        />
        {order.billingAddressSnapshot && (
          <AddressBlock
            title={labels.billingAddress}
            address={order.billingAddressSnapshot}
          />
        )}
      </div>

      <section className="space-y-4">
        <h2 className="t-h1 text-fg">{labels.items}</h2>
        <ul className="divide-y divide-line border-y border-line">
          {order.items.map((item) => (
            <li
              key={item.id}
              className="flex items-start justify-between gap-4 py-4"
            >
              <div className="space-y-1">
                <p className="t-body text-fg">{item.title || item.sku}</p>
                <p className="t-caption text-muted">× {item.quantity}</p>
              </div>
              <p className="price-figure t-body text-fg">
                {formatMoney(item.lineSubtotal, { locale })}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="t-caption text-muted">{labels.shippingMethod}</h3>
          <p className="t-body text-fg">{order.shippingMethodCode}</p>
        </div>
        <div className="space-y-2">
          <h3 className="t-caption text-muted">{labels.paymentMethod}</h3>
          <p className="t-body text-fg">{order.paymentMethod}</p>
        </div>
      </section>

      <section className="space-y-2 border-t border-line pt-6">
        <h2 className="t-caption text-muted">{labels.totals}</h2>
        <dl className="space-y-2 t-body">
          <div className="flex justify-between text-muted">
            <dt>{labels.totalsSubtotal}</dt>
            <dd className="price-figure">
              {formatMoney(order.subtotal, { locale })}
            </dd>
          </div>
          <div className="flex justify-between text-muted">
            <dt>{labels.totalsTax}</dt>
            <dd className="price-figure">
              {formatMoney(order.tax, { locale })}
            </dd>
          </div>
          <div className="flex justify-between text-muted">
            <dt>{labels.totalsShipping}</dt>
            <dd className="price-figure">
              {formatMoney(order.shipping, { locale })}
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-3 text-fg">
            <dt>{labels.totalsTotal}</dt>
            <dd className="price-figure">
              {formatMoney(order.total, { locale })}
            </dd>
          </div>
        </dl>
      </section>

      <p className="t-caption text-muted">
        {labels.contact}{" "}
        <a
          href={contactHref}
          className="text-fg underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
        >
          {labels.contactLink}
        </a>
      </p>
    </div>
  );
}

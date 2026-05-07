/**
 * AccountOverview — landing surface inside `/account`.
 *
 * Responsibilities:
 *   1. Auth gate. The Astro page is statically generated, so the gate has
 *      to live on the client. We call `auth.me()` on mount and redirect to
 *      `/sign-in?next=<current path>` when no session is present. While the
 *      call is in flight we show the skeleton.
 *   2. Greeting (the customer's display name or email).
 *   3. Recent-orders teaser (up to 3 most recent).
 *   4. Quick-link tiles to the deeper sections.
 *
 * Money is formatted through `@mt-commerce/core/money`; status strings come
 * from the parent so the island stays locale-independent.
 */
import { useEffect, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import {
  ApiError,
  createClient,
  type Order,
  type StorefrontMe,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";

export interface AccountOverviewLabels {
  greeting: string; // "Halo, {name}."
  emailLabel: string;
  phoneLabel: string;
  recentOrders: string;
  recentOrdersEmpty: string;
  viewAllOrders: string;
  quickLinks: string;
  ordersLink: string;
  addressesLink: string;
  profileLink: string;
  status: Record<Order["status"], string>;
}

export interface AccountOverviewProps {
  /** BCP47 locale used by `Intl.NumberFormat`. */
  locale: string;
  /** Short locale used by SDK calls. */
  apiLocale: "id" | "en";
  /** Where to send the user when they are not signed in. */
  signInHref: string;
  /** Path of the current page; sent as `?next=` on the sign-in redirect. */
  currentPath: string;
  /** Pre-built per-section hrefs. */
  hrefs: {
    orders: string;
    addresses: string;
    profile: string;
  };
  labels: AccountOverviewLabels;
}

type Phase = "loading" | "ready" | "redirecting" | "error";

export default function AccountOverview({
  locale,
  apiLocale,
  signInHref,
  currentPath,
  hrefs,
  labels,
}: AccountOverviewProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<StorefrontMe | null>(null);
  const [recentOrders, setRecentOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await refreshAccount();
        if (cancelled) return;
        if (!result.user) {
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        setMe(result);
        setPhase("ready");

        // Best-effort recent-orders fetch. The full /orders page handles
        // its own loading/error UI; the teaser stays silent on failure.
        if (result.customer?.id) {
          try {
            const client = createClient({
              baseUrl: resolveApiUrl(),
              locale: apiLocale,
            });
            const page = await client.storefront.customer.orders.list(
              { pageSize: 3 },
              { customerId: result.customer.id },
            );
            if (!cancelled) setRecentOrders(page.data);
          } catch {
            if (!cancelled) setRecentOrders([]);
          }
        } else {
          setRecentOrders([]);
        }
      } catch (err) {
        if (cancelled) return;
        // A 401 from `auth.me()` would have surfaced as `user: null` rather
        // than an error, so reaching here means transport failure. Keep the
        // cached customerId in place (the user might just have flaky wifi)
        // and surface the generic shell so the sidebar still renders.
        if (err instanceof ApiError && err.status === 401) {
          writeCachedCustomerId(null);
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
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
        <div className="h-24 w-full skeleton" />
        <div className="h-32 w-full skeleton" />
      </div>
    );
  }

  if (phase === "error" || !me?.user) {
    // Defensive fallback — render an apologetic shell instead of crashing.
    return (
      <div className="space-y-6">
        <p className="t-body text-muted">{labels.recentOrdersEmpty}</p>
      </div>
    );
  }

  const displayName =
    me.customer?.displayName ?? me.user.name ?? me.user.email;
  const greeting = labels.greeting.replace("{name}", displayName);

  return (
    <div className="space-y-12">
      <header className="space-y-2">
        <h1 className="t-display text-fg">{greeting}</h1>
        <dl className="grid gap-x-8 gap-y-1 t-body text-muted sm:grid-cols-[auto_1fr]">
          <dt className="t-caption text-faint">{labels.emailLabel}</dt>
          <dd>{me.user.email}</dd>
          {me.customer?.phone && (
            <>
              <dt className="t-caption text-faint">{labels.phoneLabel}</dt>
              <dd>{me.customer.phone}</dd>
            </>
          )}
        </dl>
      </header>

      <section className="space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="t-h1 text-fg">{labels.recentOrders}</h2>
          <a
            href={hrefs.orders}
            className="t-caption text-muted underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
          >
            {labels.viewAllOrders} &rarr;
          </a>
        </header>
        {recentOrders === null ? (
          <div className="h-24 w-full skeleton" aria-busy="true" />
        ) : recentOrders.length === 0 ? (
          <p className="t-body text-muted">{labels.recentOrdersEmpty}</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {recentOrders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-3 py-4"
              >
                <div className="space-y-1">
                  <p className="t-body text-fg">{order.orderNumber}</p>
                  <p className="t-caption text-faint">
                    {new Date(order.createdAt).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {" · "}
                    {labels.status[order.status]}
                  </p>
                </div>
                <p className="price-figure t-body text-fg">
                  {formatMoney(order.total, { locale })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="t-h1 text-fg">{labels.quickLinks}</h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {[
            { href: hrefs.orders, label: labels.ordersLink },
            { href: hrefs.addresses, label: labels.addressesLink },
            { href: hrefs.profile, label: labels.profileLink },
          ].map((tile) => (
            <li key={tile.href}>
              <a
                href={tile.href}
                className="block border border-line bg-paper p-5 t-body text-fg transition-colors duration-150 hover:border-fg hover:text-accent"
              >
                {tile.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

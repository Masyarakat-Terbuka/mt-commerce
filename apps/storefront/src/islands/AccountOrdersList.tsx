/**
 * AccountOrdersList — list view for `/account/orders`.
 *
 * Same auth-gate pattern as the overview island: hydrate, call `me()`,
 * redirect to sign-in when no session is present, otherwise fetch the
 * customer's orders newest-first.
 *
 * Pagination is intentionally simple at v0.1 — prev/next links, no jump-
 * to-page widget. The `pageSize` defaults to the API's 20.
 */
import { useEffect, useState } from "react";
import { format as formatMoney } from "@mt-commerce/core/money";
import {
  ApiError,
  createClient,
  type Order,
  type Paginated,
} from "@mt-commerce/sdk";
import { resolveApiUrl } from "../lib/api.js";
import {
  buildSignInHref,
  refreshAccount,
  writeCachedCustomerId,
} from "../lib/account.js";

export interface AccountOrdersListLabels {
  title: string;
  empty: string;
  shopCta: string;
  loading: string;
  error: string;
  colNumber: string;
  colDate: string;
  colStatus: string;
  colTotal: string;
  detailLink: string;
  paginationPrev: string;
  paginationNext: string;
  status: Record<Order["status"], string>;
}

export interface AccountOrdersListProps {
  locale: string;
  apiLocale: "id" | "en";
  signInHref: string;
  currentPath: string;
  /** Path of `/products` (the "start shopping" CTA when there are no orders). */
  shopHref: string;
  /**
   * Static detail-page URL the list links to with `?o=<orderNumber>`
   * appended. Astro's static output cannot enumerate orders at build time,
   * so the detail route is a single static page that reads `?o=` on the
   * client (same shape as the checkout-confirmation page).
   */
  detailHrefPrefix: string;
  labels: AccountOrdersListLabels;
}

const PAGE_SIZE = 20;

type Phase = "loading" | "ready" | "redirecting" | "error";

export default function AccountOrdersList({
  locale,
  apiLocale,
  signInHref,
  currentPath,
  shopHref,
  detailHrefPrefix,
  labels,
}: AccountOrdersListProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [page, setPage] = useState<number>(1);
  const [data, setData] = useState<Paginated<Order> | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  // Auth gate runs once on mount; the customerId is cached for subsequent
  // page changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await refreshAccount();
        if (cancelled) return;
        if (!me.user) {
          setPhase("redirecting");
          window.location.replace(buildSignInHref(signInHref, currentPath));
          return;
        }
        setCustomerId(me.customer?.id ?? null);
      } catch (err) {
        if (cancelled) return;
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
  }, [signInHref, currentPath]);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      try {
        const client = createClient({
          baseUrl: resolveApiUrl(),
          locale: apiLocale,
        });
        const result = await client.storefront.customer.orders.list(
          { page, pageSize: PAGE_SIZE },
          { customerId },
        );
        if (cancelled) return;
        setData(result);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiLocale, customerId, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="t-display text-fg">{labels.title}</h1>
      </header>

      {phase === "loading" || phase === "redirecting" ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 w-full skeleton" />
          ))}
        </div>
      ) : phase === "error" ? (
        <p role="alert" className="t-body text-danger">
          {labels.error}
        </p>
      ) : !data || data.data.length === 0 ? (
        <div className="space-y-4">
          <p className="t-body text-muted">{labels.empty}</p>
          <a
            href={shopHref}
            className="t-body text-fg underline-offset-[6px] transition-colors duration-150 hover:text-accent hover:underline"
          >
            {labels.shopCta} &rarr;
          </a>
        </div>
      ) : (
        <>
          {/*
            Table layout on desktop (mid-density list of 4 columns), card
            layout on mobile (each row stacks). The semantic table stays
            in the DOM either way so screen readers get the structure.
          */}
          <table className="w-full border-y border-line">
            <caption className="sr-only">{labels.title}</caption>
            <thead className="hidden md:table-header-group">
              <tr className="t-overline text-faint">
                <th scope="col" className="py-3 text-left">
                  {labels.colNumber}
                </th>
                <th scope="col" className="py-3 text-left">
                  {labels.colDate}
                </th>
                <th scope="col" className="py-3 text-left">
                  {labels.colStatus}
                </th>
                <th scope="col" className="py-3 text-right">
                  {labels.colTotal}
                </th>
                <th scope="col" className="py-3" aria-hidden="true" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.data.map((order) => (
                <tr
                  key={order.id}
                  className="block py-4 md:table-row md:py-0"
                >
                  <td className="block t-body text-fg md:table-cell md:py-4">
                    <a
                      href={`${detailHrefPrefix}?o=${encodeURIComponent(
                        order.orderNumber,
                      )}`}
                      className="underline-offset-[4px] transition-colors duration-150 hover:text-accent hover:underline"
                    >
                      {order.orderNumber}
                    </a>
                  </td>
                  <td className="block t-caption text-muted md:table-cell md:py-4">
                    {new Date(order.createdAt).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="block t-caption text-muted md:table-cell md:py-4">
                    {labels.status[order.status]}
                  </td>
                  <td className="block price-figure t-body text-fg md:table-cell md:py-4 md:text-right">
                    {formatMoney(order.total, { locale })}
                  </td>
                  <td className="block py-2 md:table-cell md:py-4 md:text-right">
                    <a
                      href={`${detailHrefPrefix}?o=${encodeURIComponent(
                        order.orderNumber,
                      )}`}
                      className="t-caption text-muted transition-colors duration-150 hover:text-accent"
                    >
                      {labels.detailLink} &rarr;
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <nav
              aria-label={labels.title}
              className="flex items-center justify-between pt-4 t-caption text-muted"
            >
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="lowercase tracking-[0.05em] transition-colors duration-150 hover:text-accent disabled:opacity-50"
              >
                &larr; {labels.paginationPrev}
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="lowercase tracking-[0.05em] transition-colors duration-150 hover:text-accent disabled:opacity-50"
              >
                {labels.paginationNext} &rarr;
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

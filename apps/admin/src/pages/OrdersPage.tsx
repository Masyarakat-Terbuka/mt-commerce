/**
 * Pesanan — admin order list.
 *
 * Mirrors `ProductsPage` for the parts that are the same shape (debounced
 * search, paged table, skeleton/empty/error states), and diverges where
 * orders genuinely differ:
 *
 *  - URL state: filters (status, email search, date range, page) live in
 *    the URL via TanStack Router's `validateSearch`. Refresh and link
 *    sharing both keep their state. We push search updates with
 *    `replace: true` while the user types so the browser history isn't
 *    polluted with one entry per keystroke.
 *
 *  - Search semantics: the admin orders list endpoint accepts an `email`
 *    filter (no full-text search at v0.1). The input is therefore framed
 *    as "Search by customer email" so the operator's expectation matches
 *    what the API actually does. Searching by `orderNumber` happens via
 *    the breadcrumb / direct link to `/pesanan/<orderNumber>` instead.
 *
 *  - `keepPreviousData` (TanStack Query v5 → `placeholderData: keepPrevious`)
 *    keeps the previous page on screen while the next loads.
 */
import * as React from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { format as formatMoney } from "@mt-commerce/core/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type Order, type OrderStatus } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useLocale, useTranslator } from "@/lib/i18n";

const PAGE_SIZE = 20;

/**
 * The status filter values the URL accepts. `"all"` is encoded as the
 * absence of the query parameter on the wire, but kept as a sentinel in
 * the UI to make the Select binding straightforward.
 */
export const ORDER_LIST_STATUS_OPTIONS = [
  "all",
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
] as const;

export type OrdersListStatus = (typeof ORDER_LIST_STATUS_OPTIONS)[number];

export interface OrdersListSearch {
  /** Status filter; absent = no filter (the UI maps absent → "all"). */
  status?: OrdersListStatus;
  /** Page number; absent = page 1. */
  page?: number;
  /** Customer email substring (exact match server-side). */
  email?: string;
  /** ISO-8601 date string (YYYY-MM-DD) for the lower bound. */
  from?: string;
  /** ISO-8601 date string (YYYY-MM-DD) for the upper bound. */
  to?: string;
  /**
   * Filter to a specific customer's orders. Used by the customer detail page's
   * "View all orders" link. Empty / missing = no filter.
   */
  customerId?: string;
}

const STATUS_LABEL_KEYS: Record<OrdersListStatus, string> = {
  all: "orders.status.all",
  pending_payment: "orders.status.pending_payment",
  paid: "orders.status.paid",
  fulfilled: "orders.status.fulfilled",
  cancelled: "orders.status.cancelled",
  refunded: "orders.status.refunded",
};

const STATUS_BADGE_VARIANT: Record<
  OrderStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending_payment: "secondary",
  paid: "default",
  fulfilled: "default",
  cancelled: "destructive",
  refunded: "outline",
};

/**
 * Tiny debounce hook — same one as `ProductsPage`. We could lift it into
 * `lib/`, but two consumers is the point at which the lift is premature.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Convert a `Date` (UTC) to a `YYYY-MM-DD` string in the user's local
 * timezone. We use the local timezone deliberately: an operator filtering
 * by "today" means today in their wall-clock, not UTC.
 */
function toIsoDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Render an absolute date for the tooltip. Falls back to `toString` if
 * `Intl.DateTimeFormat` is unavailable (it isn't, in practice — but the
 * fallback keeps the type system honest without an `as`).
 */
function absoluteDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(value);
}

export function OrdersPage() {
  const t = useTranslator();
  const { locale } = useLocale();

  // `from` is a route-id, not a URL — TanStack Router prefixes nested routes
  // with their parent's id, and `/pesanan` lives under the `gated` layout.
  const search = useSearch({ from: "/gated/pesanan" }) as OrdersListSearch;
  const navigate = useNavigate();

  // Local input mirrors the URL `email` so the field is responsive while
  // the URL sync stays debounced.
  const [emailInput, setEmailInput] = React.useState(search.email ?? "");
  const debouncedEmail = useDebouncedValue(emailInput.trim(), 300);

  // Push the debounced email into the URL once it stabilises. Pushing on
  // every keystroke would clobber browser history; pushing in an effect
  // here keeps the URL the source of truth for query/cache keying.
  React.useEffect(() => {
    if ((search.email ?? "") === debouncedEmail) return;
    void navigate({
      to: "/pesanan",
      search: (prev) => ({
        ...(prev as OrdersListSearch),
        email: debouncedEmail.length > 0 ? debouncedEmail : undefined,
        page: 1,
      }),
      replace: true,
    });
  }, [debouncedEmail, navigate, search.email]);

  // If the URL email changes from the outside (e.g. back/forward), keep
  // the input in sync so the field never disagrees with the URL.
  React.useEffect(() => {
    setEmailInput((current) => {
      const next = search.email ?? "";
      return current === next ? current : next;
    });
  }, [search.email]);

  const setStatus = React.useCallback(
    (next: OrdersListStatus) => {
      void navigate({
        to: "/pesanan",
        search: (prev) => ({
          ...(prev as OrdersListSearch),
          status: next,
          page: 1,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  const setDateRange = React.useCallback(
    (key: "from" | "to", value: string | undefined) => {
      void navigate({
        to: "/pesanan",
        search: (prev) => ({
          ...(prev as OrdersListSearch),
          [key]: value && value.length > 0 ? value : undefined,
          page: 1,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  const clearDateRange = React.useCallback(() => {
    void navigate({
      to: "/pesanan",
      search: (prev) => {
        const { from: _from, to: _to, ...rest } = prev as OrdersListSearch;
        return { ...rest, page: 1 };
      },
      replace: true,
    });
  }, [navigate]);

  const setPage = React.useCallback(
    (next: number) => {
      void navigate({
        to: "/pesanan",
        search: (prev) => ({ ...(prev as OrdersListSearch), page: next }),
      });
    },
    [navigate],
  );

  const currentPage = search.page ?? 1;
  const currentStatus = search.status ?? "all";

  const queryKey = [
    "admin",
    "orders",
    {
      page: currentPage,
      status: currentStatus,
      email: search.email ?? "",
      from: search.from ?? "",
      to: search.to ?? "",
      customerId: search.customerId ?? "",
    },
  ] as const;

  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      api.admin.orders.list({
        page: currentPage,
        pageSize: PAGE_SIZE,
        ...(currentStatus !== "all" ? { status: currentStatus } : {}),
        ...(search.email ? { email: search.email } : {}),
        ...(search.customerId ? { customerId: search.customerId } : {}),
        // The API parses `createdFrom` / `createdTo` as RFC 3339; passing
        // a date-only string is accepted because Zod's `coerce.date()`
        // takes anything `new Date(...)` can read. We emit ISO date-only
        // (`YYYY-MM-DD`) which `Date` interprets as 00:00 UTC.
        ...(search.from ? { createdFrom: search.from } : {}),
        ...(search.to ? { createdTo: search.to } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("orders.list_title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("orders.list_subhead")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          inputMode="email"
          placeholder={t("orders.search_placeholder")}
          aria-label={t("orders.search_placeholder")}
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          className="h-7 w-full max-w-xs"
        />
        <Select
          value={search.status ?? "all"}
          onValueChange={(value) => setStatus(value as OrdersListStatus)}
        >
          <SelectTrigger className="h-7 w-[180px]">
            <SelectValue
              placeholder={t("orders.status_label")}
              aria-label={t("orders.status_label")}
            />
          </SelectTrigger>
          <SelectContent>
            {ORDER_LIST_STATUS_OPTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(STATUS_LABEL_KEYS[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          aria-label={t("orders.date.from")}
          value={search.from ?? ""}
          max={search.to ?? toIsoDate(new Date())}
          onChange={(e) => setDateRange("from", e.target.value)}
          className="h-7 w-[150px]"
        />
        <Input
          type="date"
          aria-label={t("orders.date.to")}
          value={search.to ?? ""}
          min={search.from ?? undefined}
          max={toIsoDate(new Date())}
          onChange={(e) => setDateRange("to", e.target.value)}
          className="h-7 w-[150px]"
        />
        {search.from || search.to ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearDateRange}
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon />
            <span>{t("orders.date.clear")}</span>
          </Button>
        ) : null}
        {/* Live region so assistive tech announces "loading" while a
            background fetch is in flight without taking focus. */}
        <span className="sr-only" aria-live="polite">
          {isFetching ? t("common.loading") : ""}
        </span>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("orders.error.title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("orders.error.title")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("orders.error.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!isError ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("orders.columns.number")}</TableHead>
                <TableHead>{t("orders.columns.customer")}</TableHead>
                <TableHead className="w-32 text-right">
                  {t("orders.columns.total")}
                </TableHead>
                <TableHead className="w-36">
                  {t("orders.columns.status")}
                </TableHead>
                <TableHead className="w-40">
                  {t("orders.columns.placed_at")}
                </TableHead>
                <TableHead className="w-20 text-right">
                  <span className="sr-only">
                    {t("orders.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && !data ? (
                Array.from({ length: 5 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-12" />
                    </TableCell>
                  </TableRow>
                ))
              ) : data && data.data.length > 0 ? (
                data.data.map((order) => (
                  <OrdersRow key={order.id} order={order} locale={locale} t={t} />
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("orders.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("orders.empty.body")}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {data && data.data.length > 0 && totalPages > 1 ? (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={currentPage <= 1}
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage > 1) setPage(currentPage - 1);
                }}
              />
            </PaginationItem>
            {Array.from({ length: totalPages }).map((_, idx) => {
              const pageNumber = idx + 1;
              return (
                <PaginationItem key={pageNumber}>
                  <PaginationLink
                    href="#"
                    isActive={pageNumber === currentPage}
                    onClick={(e) => {
                      e.preventDefault();
                      setPage(pageNumber);
                    }}
                  >
                    {pageNumber}
                  </PaginationLink>
                </PaginationItem>
              );
            })}
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={currentPage >= totalPages}
                onClick={(e) => {
                  e.preventDefault();
                  if (currentPage < totalPages) setPage(currentPage + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}

/**
 * One row, extracted so the date math + tooltip wiring is read once.
 *
 * `Order.total.amount` is a `bigint` with the right scale for the
 * currency, so `formatMoney` handles it directly — no extra conversion.
 */
function OrdersRow({
  order,
  locale,
  t,
}: {
  order: Order;
  locale: "id" | "en";
  t: (key: string) => string;
}) {
  const intlLocale = locale === "id" ? "id-ID" : "en-US";
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <Link
          to="/pesanan/$orderNumber"
          params={{ orderNumber: order.orderNumber }}
          className="hover:underline"
        >
          {order.orderNumber}
        </Link>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">
            {order.email || t("orders.guest_customer")}
          </span>
          {order.customerId ? (
            <span className="text-xs text-muted-foreground">
              {order.customerId}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatMoney(order.total, { locale: intlLocale })}
      </TableCell>
      <TableCell>
        <Badge variant={STATUS_BADGE_VARIANT[order.status]}>
          {t(STATUS_LABEL_KEYS[order.status])}
        </Badge>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{relativeTime(order.createdAt, locale)}</span>
          </TooltipTrigger>
          <TooltipContent>
            {absoluteDate(order.createdAt, intlLocale)}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-right">
        <Button asChild variant="ghost" size="sm">
          <Link
            to="/pesanan/$orderNumber"
            params={{ orderNumber: order.orderNumber }}
            aria-label={t("orders.action.view")}
          >
            <span>{t("orders.action.view")}</span>
            <HugeiconsIcon icon={ArrowRight02Icon} data-icon />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}


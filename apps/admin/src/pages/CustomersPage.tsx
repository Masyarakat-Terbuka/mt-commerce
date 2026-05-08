/**
 * Pelanggan — admin customer list.
 *
 * Mirrors `ProductsPage` for predictable behavior:
 *   - Filters: a single `search` field over name/email/phone, debounced
 *     300ms before it becomes a query input.
 *   - Pagination: shadcn `Pagination` mapped to TanStack Query's `page`.
 *   - URL state: `page` and `search` survive in the URL via TanStack Router
 *     `search()`. Refresh, deep-link, and back-button all restore the
 *     same view. The router's `validateSearch` keeps the type-safe handle
 *     into `useSearch`.
 *   - States: skeleton on first load, empty when zero results, alert on
 *     error.
 *
 * Why no status filter or sort: the API's `listCustomersQuery` does not
 * yet expose either (verified in `apps/api/src/modules/customer/types.ts`).
 * Faking client-side controls that don't reach the server would mislead
 * the operator. When the API grows them, this screen adopts them the
 * same way `ProductsPage` does.
 */
import * as React from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mail01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useLocale, useTranslator } from "@/lib/i18n";

const PAGE_SIZE = 20;

/**
 * Tiny debounce hook. We could pull in a library, but this is one of the
 * cases where a 6-line hook beats a dependency. Mirrors `ProductsPage`.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function CustomersPage() {
  const t = useTranslator();
  const { locale } = useLocale();
  const navigate = useNavigate();

  // URL → state. The router validates the search shape, so reading is safe
  // without extra defensive parsing on this side. `strict: false` because
  // the gated layout's route id (`/gated/pelanggan`) does not match the
  // pathname literal, and we only need the loose typed handle here.
  const search = useSearch({ strict: false }) as {
    page?: number;
    q?: string;
  };
  const page = search.page ?? 1;
  const urlQuery = search.q ?? "";

  const [searchInput, setSearchInput] = React.useState(urlQuery);
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 300);

  // Push search-state changes back into the URL when the debounced value
  // settles. `replace: true` so each keystroke does not pollute history.
  // Pulling `page` out at the same time keeps the user on page 1 whenever
  // the filter changes — the same reset rule `ProductsPage` uses, but
  // expressed through navigation rather than local `setPage`.
  React.useEffect(() => {
    if (debouncedSearch === urlQuery) return;
    void navigate({
      to: "/pelanggan",
      search: debouncedSearch.length > 0 ? { q: debouncedSearch } : {},
      replace: true,
    });
    // We deliberately depend only on `debouncedSearch` and `urlQuery`. The
    // navigate function is referentially stable from TanStack Router.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, urlQuery]);

  const queryKey = [
    "admin",
    "customers",
    { page, search: debouncedSearch },
  ] as const;

  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      api.admin.customers.list({
        page,
        pageSize: PAGE_SIZE,
        ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  const setPage = React.useCallback(
    (next: number) => {
      void navigate({
        to: "/pelanggan",
        search: {
          ...(debouncedSearch.length > 0 ? { q: debouncedSearch } : {}),
          ...(next > 1 ? { page: next } : {}),
        },
      });
    },
    [navigate, debouncedSearch],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("customers.list_title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("customers.list_subhead")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={t("customers.search_placeholder")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-7 w-full max-w-xs"
          aria-label={t("customers.search_placeholder")}
        />
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("customers.error.title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("customers.error.body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("customers.error.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!isError ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("customers.columns.name")}</TableHead>
                <TableHead className="w-72">
                  {t("customers.columns.email")}
                </TableHead>
                <TableHead className="w-40">
                  {t("customers.columns.phone")}
                </TableHead>
                <TableHead className="w-40">
                  {t("customers.columns.joined")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && !data ? (
                Array.from({ length: 6 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-56" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-28" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                  </TableRow>
                ))
              ) : data && data.data.length > 0 ? (
                data.data.map((customer) => {
                  const displayLabel =
                    customer.displayName?.trim().length
                      ? customer.displayName
                      : customer.email;
                  return (
                    <TableRow key={customer.id}>
                      <TableCell>
                        <Link
                          to="/pelanggan/$id"
                          params={{ id: customer.id }}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {displayLabel}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 text-sm">
                          <HugeiconsIcon
                            icon={Mail01Icon}
                            className="size-3.5 text-muted-foreground"
                          />
                          <span className="truncate">{customer.email}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {customer.phone ? (
                          <span className="inline-flex items-center gap-1.5 text-sm">
                            <HugeiconsIcon
                              icon={SmartPhone01Icon}
                              className="size-3.5 text-muted-foreground"
                            />
                            <span>{customer.phone}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(customer.createdAt, locale)}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("customers.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("customers.empty.body")}
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
                aria-disabled={page <= 1}
                onClick={(e) => {
                  e.preventDefault();
                  if (page > 1) setPage(page - 1);
                }}
              />
            </PaginationItem>
            {Array.from({ length: totalPages }).map((_, idx) => {
              const pageNumber = idx + 1;
              return (
                <PaginationItem key={pageNumber}>
                  <PaginationLink
                    href="#"
                    isActive={pageNumber === page}
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
                aria-disabled={page >= totalPages}
                onClick={(e) => {
                  e.preventDefault();
                  if (page < totalPages) setPage(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}

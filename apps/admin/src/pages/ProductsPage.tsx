/**
 * Produk — admin product list.
 *
 * - Filters: search, status, sort. The search is debounced 300ms before it
 *   becomes a query input; without that the user pays a request per
 *   keystroke.
 * - Table: columns per the spec (image, nama, status, mata uang, diperbarui).
 * - Pagination: shadcn `Pagination` mapped to TanStack Query's pageIndex.
 * - States: skeleton on first load, empty + CTA when zero results, alert
 *   when the call errors.
 *
 * Per `vercel-react-best-practices`:
 *  - `keepPreviousData` (TanStack Query v5 → `placeholderData: keepPrevious`)
 *    keeps the previous page on screen while the next one loads — no flicker.
 *  - The query key includes every filter so the cache deduplicates
 *    repeat lookups when the user pages back.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Edit02Icon,
  ImageAdd01Icon,
} from "@hugeicons/core-free-icons";
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
import { api, type ProductSort, type ProductStatus } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useLocale, useTranslator } from "@/lib/i18n";

const PAGE_SIZE = 20;

const STATUS_FILTER_VALUES = ["all", "draft", "active", "archived"] as const;
type StatusFilter = (typeof STATUS_FILTER_VALUES)[number];

const SORT_VALUES: ProductSort[] = ["newest", "price_asc", "price_desc"];

const STATUS_LABEL_KEYS: Record<ProductStatus, string> = {
  draft: "products.status.draft",
  active: "products.status.active",
  archived: "products.status.archived",
};

const STATUS_BADGE_VARIANT: Record<
  ProductStatus,
  "default" | "secondary" | "outline"
> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

/**
 * Tiny debounce hook. We could pull in a library, but this is one of the
 * cases where a 6-line hook beats a dependency.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function ProductsPage() {
  const t = useTranslator();
  const { locale } = useLocale();

  const [searchInput, setSearchInput] = React.useState("");
  const [status, setStatusState] = React.useState<StatusFilter>("all");
  const [sort, setSortState] = React.useState<ProductSort>("newest");
  const [page, setPage] = React.useState(1);

  const debouncedSearch = useDebouncedValue(searchInput.trim(), 300);

  // Reset paging when filters change directly through the setters rather
  // than via a useEffect on derived dependencies. Per
  // `vercel-react-best-practices/rerender-derived-state-no-effect`, computing
  // dependent state during the same event that triggered the change avoids
  // a wasted render pass that an effect-based reset would introduce.
  const setStatus = React.useCallback((next: StatusFilter) => {
    setStatusState(next);
    setPage(1);
  }, []);
  const setSort = React.useCallback((next: ProductSort) => {
    setSortState(next);
    setPage(1);
  }, []);
  // The search input is debounced; the page reset has to track the debounced
  // value, not the raw input. We use the React idiom for "store state from
  // previous renders": a state cell that compares against the latest derived
  // input, then sets itself + the page in the same render. This avoids the
  // extra render pass a useEffect would cost (per
  // `rerender-derived-state-no-effect`), and avoids reading refs during
  // render — which the React 19 / Compiler ESLint rules now block.
  const [lastIssuedSearch, setLastIssuedSearch] =
    React.useState(debouncedSearch);
  if (lastIssuedSearch !== debouncedSearch) {
    setLastIssuedSearch(debouncedSearch);
    if (page !== 1) setPage(1);
  }

  const queryKey = [
    "admin",
    "products",
    { page, status, sort, search: debouncedSearch },
  ] as const;

  const { data, isPending, isError, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      api.admin.products.list({
        page,
        pageSize: PAGE_SIZE,
        sort,
        ...(status !== "all" ? { status } : {}),
        ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
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
            {t("products.title")}
          </h1>
        </div>
        <Button asChild>
          <Link to="/produk/baru">
            <HugeiconsIcon icon={Add01Icon} data-icon />
            <span>{t("products.new_button")}</span>
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={t("products.search")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-7 w-full max-w-xs"
        />
        <Select
          value={status}
          onValueChange={(value) => setStatus(value as StatusFilter)}
        >
          <SelectTrigger className="h-7 w-[140px]">
            <SelectValue
              placeholder={t("products.status_label")}
              aria-label={t("products.status_label")}
            />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTER_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all"
                  ? t("products.status.all")
                  : t(STATUS_LABEL_KEYS[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(value) => setSort(value as ProductSort)}
        >
          <SelectTrigger className="h-7 w-[160px]">
            <SelectValue
              placeholder={t("products.sort_label")}
              aria-label={t("products.sort_label")}
            />
          </SelectTrigger>
          <SelectContent>
            {SORT_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`products.sort.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("common.error")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("products.error")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!isError ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <span className="sr-only">{t("products.col.image")}</span>
                </TableHead>
                <TableHead>{t("products.col.name")}</TableHead>
                <TableHead className="w-28">
                  {t("products.col.status")}
                </TableHead>
                <TableHead className="w-24">
                  {t("products.col.currency")}
                </TableHead>
                <TableHead className="w-40">
                  {t("products.col.updated")}
                </TableHead>
                <TableHead className="w-20 text-right">
                  <span className="sr-only">{t("products.col.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && !data ? (
                Array.from({ length: 6 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="size-9 rounded" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-14" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-10" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-12" />
                    </TableCell>
                  </TableRow>
                ))
              ) : data && data.data.length > 0 ? (
                data.data.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell>
                      {product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt={product.imageAlt ?? product.title}
                          loading="lazy"
                          className="size-9 rounded object-cover"
                        />
                      ) : (
                        <div className="flex size-9 items-center justify-center rounded bg-muted text-muted-foreground">
                          <HugeiconsIcon
                            icon={ImageAdd01Icon}
                            className="size-4"
                          />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{product.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {product.slug}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE_VARIANT[product.status]}>
                        {t(STATUS_LABEL_KEYS[product.status])}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {product.defaultCurrency}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {relativeTime(product.updatedAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link
                          to="/produk/$id"
                          params={{ id: product.id }}
                          aria-label={t("products.action.edit")}
                        >
                          <HugeiconsIcon icon={Edit02Icon} data-icon />
                          <span>{t("products.action.edit")}</span>
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("products.empty")}</EmptyTitle>
                        <EmptyDescription>
                          {t("products.coming_soon")}
                        </EmptyDescription>
                      </EmptyHeader>
                      <Button asChild variant="outline" className="mt-3">
                        <Link to="/produk/baru">
                          <HugeiconsIcon icon={Add01Icon} data-icon />
                          <span>{t("products.empty_cta")}</span>
                        </Link>
                      </Button>
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

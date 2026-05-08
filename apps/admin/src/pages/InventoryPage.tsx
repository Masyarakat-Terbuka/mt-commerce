/**
 * Inventaris — admin inventory overview.
 *
 * The catalog API now exposes the full read surface for inventory:
 *   - `GET /admin/v1/variants/{id}/inventory` per variant
 *   - `GET /admin/v1/inventory/levels` paginated
 *   - `GET /admin/v1/variants/{id}/inventory/audit` — audit history
 * and the signed `POST .../inventory/adjust` mutation accepts a `reason`
 * persisted to the audit log.
 *
 * What this page does:
 *   - Lists every variant by paginating `/admin/v1/products` and flattening
 *     each product's `variants[]`. The product list remains the source of
 *     truth for the row's title/SKU/price; the inventory list endpoint is
 *     used per-row to read the live `available` count via TanStack Query
 *     keyed by variant id.
 *   - Each row prefetches its inventory level on mount (independent
 *     `useQuery`); cells render stock immediately on the first paint after
 *     the network resolves.
 *   - The adjustment dialog accepts a signed `delta` plus an optional
 *     `reason`. The reason is forwarded to the API and persisted to the
 *     audit log.
 *   - Each row has an "Audit history" affordance that opens a Sheet listing
 *     the variant's audit_log entries (newest first), paginated.
 */
import * as React from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Edit02Icon,
  FileValidationIcon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import { format as formatMoney } from "@mt-commerce/core/money";
import {
  api,
  ApiError,
  type InventoryAuditEntry,
  type InventoryLevel,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import { relativeTime } from "@/lib/format";
import { useLocale, useTranslator } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

const PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 20;
const LOW_STOCK_THRESHOLD = 5;
const INVENTORY_DELTA_LIMIT = 1_000_000;

/**
 * A flat row for the table — one entry per variant. Producing the flattened
 * shape once at the top of `useMemo` avoids repeated `.flatMap` calls in
 * render, and keeps the dialog's variant lookup O(1) by id.
 */
interface VariantRow {
  variantId: string;
  productId: string;
  productTitle: string;
  productImageUrl: string | null;
  productImageAlt: string | null;
  variantTitle: string | null;
  sku: string;
  priceAmount: bigint;
  priceCurrency: string;
  updatedAt: Date;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Per-variant cache key for the live `InventoryLevel`. The row's `useQuery`
 * fetches against `inventory.byVariantId(...)`; the adjust mutation's
 * `onSuccess` writes the response back here so the cell updates without
 * a separate refetch.
 */
function inventoryQueryKey(variantId: string) {
  return ["admin", "inventory", "level", variantId] as const;
}

function auditQueryKey(variantId: string, page: number) {
  return ["admin", "inventory", "audit", variantId, page] as const;
}

export function InventoryPage() {
  const t = useTranslator();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = React.useState("");
  const [page, setPage] = React.useState(1);
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 300);

  // Reset paging when the debounced search changes — same pattern as
  // ProductsPage. Computed during render to avoid the extra effect-driven
  // render pass.
  const [lastIssuedSearch, setLastIssuedSearch] =
    React.useState(debouncedSearch);
  if (lastIssuedSearch !== debouncedSearch) {
    setLastIssuedSearch(debouncedSearch);
    if (page !== 1) setPage(1);
  }

  const productsQueryKey = [
    "admin",
    "products-for-inventory",
    { page, search: debouncedSearch },
  ] as const;

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: productsQueryKey,
    queryFn: () =>
      api.admin.products.list({
        page,
        pageSize: PAGE_SIZE,
        sort: "newest",
        ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
      }),
    placeholderData: keepPreviousData,
  });

  const rows: VariantRow[] = React.useMemo(() => {
    if (!data) return [];
    const flat: VariantRow[] = [];
    for (const product of data.data) {
      for (const variant of product.variants) {
        flat.push({
          variantId: variant.id,
          productId: product.id,
          productTitle: product.title,
          productImageUrl: product.imageUrl,
          productImageAlt: product.imageAlt,
          variantTitle: variant.title,
          sku: variant.sku,
          priceAmount: variant.price.amount,
          priceCurrency: variant.price.currency,
          updatedAt: variant.updatedAt,
        });
      }
    }
    return flat;
  }, [data]);

  // Pagination follows the underlying products list. A product carrying
  // multiple variants will produce more than `PAGE_SIZE` rows on one page;
  // that is acceptable for the v0.1 single-currency catalog. A dedicated
  // variants/inventory list can paginate variant-by-variant when it lands.
  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  const [adjustOpenForVariantId, setAdjustOpenForVariantId] = React.useState<
    string | null
  >(null);
  const [auditOpenForVariantId, setAuditOpenForVariantId] = React.useState<
    string | null
  >(null);

  const adjustingRow = React.useMemo(
    () =>
      adjustOpenForVariantId
        ? rows.find((row) => row.variantId === adjustOpenForVariantId) ?? null
        : null,
    [adjustOpenForVariantId, rows],
  );
  const auditingRow = React.useMemo(
    () =>
      auditOpenForVariantId
        ? rows.find((row) => row.variantId === auditOpenForVariantId) ?? null
        : null,
    [auditOpenForVariantId, rows],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("inventory.list_title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("inventory.list_subhead")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={t("inventory.search_placeholder")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-7 w-full max-w-xs"
          aria-label={t("inventory.search_placeholder")}
        />
      </div>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t("inventory.error.title")}</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{t("inventory.error.body")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              {t("common.loading")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!isError ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("inventory.columns.product")}</TableHead>
                <TableHead>{t("inventory.columns.variant")}</TableHead>
                <TableHead className="w-40">
                  {t("inventory.columns.sku")}
                </TableHead>
                <TableHead className="w-32">
                  {t("inventory.columns.stock")}
                </TableHead>
                <TableHead className="w-40">
                  {t("inventory.columns.updated")}
                </TableHead>
                <TableHead className="w-48 text-right">
                  <span className="sr-only">
                    {t("inventory.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && !data ? (
                Array.from({ length: 6 }).map((_, idx) => (
                  <TableRow key={`skeleton-${idx}`}>
                    <TableCell>
                      <Skeleton className="h-3.5 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-12" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-7 w-32" />
                    </TableCell>
                  </TableRow>
                ))
              ) : rows.length > 0 ? (
                rows.map((row) => (
                  <InventoryRow
                    key={row.variantId}
                    row={row}
                    locale={locale}
                    onAdjust={() => setAdjustOpenForVariantId(row.variantId)}
                    onShowAudit={() =>
                      setAuditOpenForVariantId(row.variantId)
                    }
                  />
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-12">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>{t("inventory.empty.title")}</EmptyTitle>
                        <EmptyDescription>
                          {t("inventory.empty.body")}
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

      {data && rows.length > 0 && totalPages > 1 ? (
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

      <AdjustDialog
        row={adjustingRow}
        open={adjustingRow !== null}
        onOpenChange={(next) => {
          if (!next) setAdjustOpenForVariantId(null);
        }}
        onAdjusted={(level) => {
          // Update the live cache so the row repaints immediately. Also
          // invalidate the audit history for this variant so the Sheet (if
          // open) shows the new entry on next render.
          queryClient.setQueryData<InventoryLevel>(
            inventoryQueryKey(level.variantId),
            level,
          );
          void queryClient.invalidateQueries({
            queryKey: ["admin", "inventory", "audit", level.variantId],
          });
        }}
      />

      <AuditSheet
        row={auditingRow}
        open={auditingRow !== null}
        onOpenChange={(next) => {
          if (!next) setAuditOpenForVariantId(null);
        }}
        locale={locale}
      />
    </div>
  );
}

interface InventoryRowProps {
  row: VariantRow;
  locale: Locale;
  onAdjust: () => void;
  onShowAudit: () => void;
}

/**
 * One table row. Splitting this out keeps `useQuery` per row scoped: each
 * row pulls its own live `InventoryLevel` and re-renders independently.
 */
function InventoryRow({
  row,
  locale,
  onAdjust,
  onShowAudit,
}: InventoryRowProps) {
  const t = useTranslator();
  const { data: level, isPending: isLevelPending } = useQuery<
    InventoryLevel | null
  >({
    queryKey: inventoryQueryKey(row.variantId),
    queryFn: () => api.admin.inventory.byVariantId(row.variantId),
    // The variant-level row state is unlikely to change between paints
    // unless an adjust runs locally — the mutation's onSuccess writes to
    // this same key, so a stale window is fine.
    staleTime: 30_000,
  });

  const stockKnown = level !== undefined && level !== null;
  const isLowStock =
    stockKnown && level !== null && level.available <= LOW_STOCK_THRESHOLD;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {row.productImageUrl ? (
            <img
              src={row.productImageUrl}
              alt={row.productImageAlt ?? row.productTitle}
              loading="lazy"
              className="size-8 rounded object-cover"
            />
          ) : (
            <div className="flex size-8 items-center justify-center rounded bg-muted text-muted-foreground">
              <HugeiconsIcon icon={WarehouseIcon} className="size-3.5" />
            </div>
          )}
          <span className="font-medium">{row.productTitle}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">
            {row.variantTitle ?? <span className="text-muted-foreground">—</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatMoney(
              { amount: row.priceAmount, currency: row.priceCurrency },
              { locale: locale === "id" ? "id-ID" : "en-US" },
            )}
          </span>
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.sku}</TableCell>
      <TableCell>
        {isLevelPending ? (
          <Skeleton className="h-4 w-12" />
        ) : stockKnown ? (
          <div className="flex items-center gap-2">
            <span
              className="font-mono tabular-nums"
              aria-label={t("inventory.columns.stock")}
            >
              {level.available}
            </span>
            {isLowStock ? (
              <Badge variant="destructive">
                {t("inventory.low_stock_badge")}
              </Badge>
            ) : null}
          </div>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title={t("inventory.stock_unknown_help")}
          >
            {t("inventory.stock_unknown")}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {stockKnown
          ? relativeTime(level.updatedAt, locale)
          : relativeTime(row.updatedAt, locale)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onShowAudit}
            aria-label={`${t("inventory.action.audit")} — ${row.sku}`}
          >
            <HugeiconsIcon icon={FileValidationIcon} data-icon />
            <span>{t("inventory.action.audit")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onAdjust}
            aria-label={`${t("inventory.action.adjust")} — ${row.sku}`}
          >
            <HugeiconsIcon icon={Edit02Icon} data-icon />
            <span>{t("inventory.action.adjust")}</span>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

interface AdjustDialogProps {
  row: VariantRow | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onAdjusted: (level: InventoryLevel) => void;
}

/**
 * Adjust-stock confirmation dialog. AlertDialog (rather than Dialog) to make
 * the destructive nature of negative deltas explicit — the action requires a
 * deliberate two-click flow per the a11y guidance for stock-changing ops.
 *
 * The `reason` field is now persisted server-side: the API stores it on the
 * audit_log row alongside the actor and the before/after counts.
 */
function AdjustDialog({
  row,
  open,
  onOpenChange,
  onAdjusted,
}: AdjustDialogProps) {
  const t = useTranslator();
  const [deltaInput, setDeltaInput] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );

  const adjustMutation = useMutation({
    mutationFn: async (input: { delta: number; reason?: string }) => {
      if (!row) throw new Error("No row selected.");
      return api.admin.inventory.adjust(row.variantId, input);
    },
    onSuccess: (level) => {
      onAdjusted(level);
      toast.success(
        t("inventory.adjust.success").replace(
          "{available}",
          String(level.available),
        ),
      );
      onOpenChange(false);
    },
  });

  // Reset form state when the dialog opens or switches to a different row.
  // Per `vercel-react-best-practices/rerender-derived-state-no-effect`, we
  // do this by comparing the trigger key against state from the previous
  // render and setting state during render — no effect, no cascading
  // re-render, and the reset is observed in the same paint as the open.
  // Tracking `(open, variantId)` together as a single key keeps the logic
  // straight: we only reset on the transition into "open against this row".
  const variantId = row?.variantId ?? null;
  const triggerKey = open ? `open:${variantId ?? "_"}` : "closed";
  const [lastTriggerKey, setLastTriggerKey] = React.useState(triggerKey);
  if (lastTriggerKey !== triggerKey) {
    setLastTriggerKey(triggerKey);
    if (open) {
      setDeltaInput("");
      setReason("");
      setValidationError(null);
      adjustMutation.reset();
    }
  }

  function parseDelta(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return null;
    if (parsed === 0) return null;
    if (parsed < -INVENTORY_DELTA_LIMIT || parsed > INVENTORY_DELTA_LIMIT) {
      return null;
    }
    return parsed;
  }

  function handleConfirm() {
    setValidationError(null);
    const delta = parseDelta(deltaInput);
    if (delta === null) {
      setValidationError(t("inventory.adjust.error.invalid"));
      return;
    }
    const trimmedReason = reason.trim();
    adjustMutation.mutate({
      delta,
      ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
    });
  }

  // Map server errors to user-facing messages. `conflict` is the "would go
  // negative" path; validation_error covers the other rejection cases.
  // Anything else surfaces the generic server-error string.
  const serverError = adjustMutation.error;
  const serverErrorMessage = React.useMemo(() => {
    if (!serverError) return null;
    if (serverError instanceof ApiError) {
      if (serverError.code === "conflict") {
        return t("inventory.adjust.error.would_go_negative");
      }
    }
    return t("inventory.adjust.error.server");
  }, [serverError, t]);

  const isSaving = adjustMutation.isPending;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (isSaving && !next) return; // do not allow dismissing mid-request
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("inventory.adjust.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("inventory.adjust.subhead")}
            {row ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {row.productTitle}
                {row.variantTitle ? ` — ${row.variantTitle}` : ""} · {row.sku}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="inventory-delta">
              {t("inventory.adjust.delta")}
            </Label>
            <Input
              id="inventory-delta"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              placeholder="0"
              value={deltaInput}
              onChange={(e) => {
                setDeltaInput(e.target.value);
                if (validationError) setValidationError(null);
              }}
              aria-invalid={validationError !== null}
              aria-describedby="inventory-delta-help"
              disabled={isSaving}
            />
            <p
              id="inventory-delta-help"
              className="text-xs text-muted-foreground"
            >
              {t("inventory.adjust.delta_help")}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="inventory-reason">
              {t("inventory.adjust.reason")}
            </Label>
            <Textarea
              id="inventory-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("inventory.adjust.reason_placeholder")}
              aria-describedby="inventory-reason-help"
              disabled={isSaving}
              maxLength={500}
            />
            <p
              id="inventory-reason-help"
              className="text-xs text-muted-foreground"
            >
              {t("inventory.adjust.reason_help")}
            </p>
          </div>

          {validationError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          ) : null}

          {serverErrorMessage ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{serverErrorMessage}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSaving}>
            {t("inventory.adjust.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={isSaving}
          >
            {isSaving
              ? t("inventory.adjust.confirm_saving")
              : t("inventory.adjust.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface AuditSheetProps {
  row: VariantRow | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  locale: Locale;
}

/**
 * Side sheet showing this variant's audit history. Pagination is local to
 * the sheet — opening/closing resets the page, opening for a different
 * variant resets the page. Each page is its own query key so paging back
 * and forth uses the cache.
 */
function AuditSheet({ row, open, onOpenChange, locale }: AuditSheetProps) {
  const t = useTranslator();
  const [auditPage, setAuditPage] = React.useState(1);

  // Reset paging on open / variant change. Same render-time pattern as the
  // adjust dialog — no effect, observed in the same paint.
  const variantId = row?.variantId ?? null;
  const triggerKey = open ? `open:${variantId ?? "_"}` : "closed";
  const [lastTriggerKey, setLastTriggerKey] = React.useState(triggerKey);
  if (lastTriggerKey !== triggerKey) {
    setLastTriggerKey(triggerKey);
    if (open) setAuditPage(1);
  }

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: variantId ? auditQueryKey(variantId, auditPage) : ["__noop__"],
    queryFn: () => {
      if (!variantId) {
        return Promise.resolve({
          data: [] as InventoryAuditEntry[],
          total: 0,
          page: auditPage,
          pageSize: AUDIT_PAGE_SIZE,
        });
      }
      return api.admin.inventory.auditByVariantId(variantId, {
        page: auditPage,
        pageSize: AUDIT_PAGE_SIZE,
      });
    },
    enabled: open && variantId !== null,
    placeholderData: keepPreviousData,
  });

  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : 1;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("inventory.audit.title")}</SheetTitle>
          <SheetDescription>
            {t("inventory.audit.subhead")}
            {row ? (
              <span className="mt-1 block text-xs text-muted-foreground">
                {row.productTitle}
                {row.variantTitle ? ` — ${row.variantTitle}` : ""} · {row.sku}
              </span>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto px-4">
          {isError ? (
            <Alert variant="destructive">
              <AlertTitle>{t("inventory.audit.error.title")}</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>{t("inventory.audit.error.body")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void refetch();
                  }}
                >
                  {t("inventory.audit.action.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : isPending && !data ? (
            <div className="flex flex-col gap-3 py-2">
              {Array.from({ length: 4 }).map((_, idx) => (
                <Skeleton key={idx} className="h-16 w-full" />
              ))}
            </div>
          ) : data && data.data.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("inventory.audit.empty.title")}</EmptyTitle>
                <EmptyDescription>
                  {t("inventory.audit.empty.body")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3 py-2">
              {data?.data.map((entry) => (
                <AuditEntryItem
                  key={entry.id}
                  entry={entry}
                  locale={locale}
                />
              ))}
            </ul>
          )}
        </div>

        {data && data.data.length > 0 && totalPages > 1 ? (
          <Pagination className="px-4">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  aria-disabled={auditPage <= 1}
                  onClick={(e) => {
                    e.preventDefault();
                    if (auditPage > 1) setAuditPage(auditPage - 1);
                  }}
                />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink href="#" isActive>
                  {auditPage}
                </PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  href="#"
                  aria-disabled={auditPage >= totalPages}
                  onClick={(e) => {
                    e.preventDefault();
                    if (auditPage < totalPages) setAuditPage(auditPage + 1);
                  }}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        ) : null}

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("inventory.audit.close")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

interface AuditEntryItemProps {
  entry: InventoryAuditEntry;
  locale: Locale;
}

function AuditEntryItem({ entry, locale }: AuditEntryItemProps) {
  const t = useTranslator();
  const actorLabel =
    entry.actorKind === "system"
      ? t("inventory.audit.actor.system")
      : entry.actorKind === "staff"
        ? t("inventory.audit.actor.staff")
        : t("inventory.audit.actor.customer");

  const summary = React.useMemo(() => {
    if (
      entry.deltaApplied === null ||
      entry.before === null ||
      entry.after === null
    ) {
      // Unrecognized payload (forward-compat). Render the raw action only.
      return entry.action;
    }
    const deltaSign = entry.deltaApplied > 0 ? "+" : "";
    return t("inventory.audit.delta_summary")
      .replace("{delta}", `${deltaSign}${entry.deltaApplied}`)
      .replace("{before}", String(entry.before))
      .replace("{after}", String(entry.after));
  }, [entry, t]);

  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{summary}</span>
          <span className="text-xs text-muted-foreground">
            {actorLabel}
            {entry.actorId ? ` · ${entry.actorId}` : ""} ·{" "}
            {relativeTime(entry.createdAt, locale)}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {entry.reason ?? (
          <span className="italic">{t("inventory.audit.no_reason")}</span>
        )}
      </p>
    </li>
  );
}

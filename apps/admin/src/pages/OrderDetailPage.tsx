/**
 * Pesanan — order detail.
 *
 * One screen-deep view of a single order: header, customer block,
 * addresses, line items, totals, transition controls, and an audit-log
 * timeline. Read paths use `client.admin.orders.byNumber` so the URL
 * carries the operator-friendly `ORD-YYYY-NNNNNN` handle. Mutating
 * actions (transition, cancel) hit the `id`-keyed endpoints and refetch
 * the detail + the events list on success.
 *
 * State machine integration:
 *
 *   The set of allowed transitions is *exactly* what the API's state
 *   module documents. Rather than hard-code that table here, we mirror
 *   it as a frozen lookup so the UI cannot offer a transition the API
 *   would reject — the back end remains authoritative, but the front
 *   end never lets the operator try a known-impossible move. If the API
 *   adds an edge, both `state.ts` and this map need to be updated; the
 *   route's transition handler also surfaces the API's 409 error so we
 *   are never silently wrong.
 *
 * Cancel vs transition:
 *
 *   A cancel is a transition with a reason captured. The state machine
 *   permits `pending_payment → cancelled` and `paid → cancelled`. We
 *   surface the explicit "Cancel" button (with reason field) only when
 *   the API would accept it, and we keep the transition-button list
 *   free of `cancelled` to avoid two paths leading to the same dialog.
 *
 *   Refunds and other terminal-state moves go through the regular
 *   transition button with a confirm dialog.
 */
import * as React from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  Cancel01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { format as formatMoney } from "@mt-commerce/core/money";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  api,
  ApiError,
  type OrderActorKind,
  type OrderAddressSnapshot,
  type OrderStatus,
  type OrderStatusEvent,
} from "@/lib/api";
import { useLocale, useTranslator } from "@/lib/i18n";

const STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
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
 * Mirrors `apps/api/src/modules/orders/state.ts` exactly. We keep the
 * map frozen so a typo at the call site fails to type-check.
 *
 * `cancelled` is intentionally omitted from `pending_payment`/`paid`
 * here — the dedicated cancel button covers that path, with a reason
 * field, so the regular transition list stays free of duplicate moves.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, ReadonlyArray<OrderStatus>>> = {
  pending_payment: ["paid"],
  paid: ["fulfilled", "refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

/** The two states from which the API allows `→ cancelled`. */
const CANCELLABLE_FROM: ReadonlySet<OrderStatus> = new Set([
  "pending_payment",
  "paid",
]);

const ACTOR_LABEL_KEYS: Record<OrderActorKind, string> = {
  system: "orders.detail.events.actor.system",
  staff: "orders.detail.events.actor.staff",
  customer: "orders.detail.events.actor.customer",
};

function intlLocale(locale: "id" | "en"): string {
  return locale === "id" ? "id-ID" : "en-US";
}

function absoluteDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(value);
}

function shortDateTime(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

/**
 * `useParams` from a non-strict location returns `Record<string, string>`
 * so we cast to the known shape. The route's path parameter is named
 * `orderNumber` — see `router.tsx`.
 */
function useOrderNumberParam(): string {
  const params = useParams({ strict: false }) as { orderNumber?: string };
  return params.orderNumber ?? "";
}

export function OrderDetailPage() {
  const orderNumber = useOrderNumberParam();
  const t = useTranslator();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const orderQuery = useQuery({
    queryKey: ["admin", "order", orderNumber] as const,
    queryFn: () => api.admin.orders.byNumber(orderNumber),
    enabled: orderNumber.length > 0,
  });

  // Events keyed off the order id so the cache survives a page-level
  // refetch. We only enable it once we know the id.
  const orderId = orderQuery.data?.id ?? null;
  const eventsQuery = useQuery({
    queryKey: ["admin", "order", orderId, "events"] as const,
    queryFn: () => api.admin.orders.events(orderId!),
    enabled: orderId !== null,
  });

  const refetchAll = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["admin", "order", orderNumber],
      }),
      orderId
        ? queryClient.invalidateQueries({
            queryKey: ["admin", "order", orderId, "events"],
          })
        : Promise.resolve(),
      // The list page caches per filter; bust the whole namespace so a
      // new status shows up the next time the operator goes back.
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
    ]);
  }, [orderId, orderNumber, queryClient]);

  // ---- Transition mutation ------------------------------------------------

  const [pendingTransition, setPendingTransition] =
    React.useState<OrderStatus | null>(null);
  const [transitionError, setTransitionError] = React.useState<string | null>(
    null,
  );

  const transitionMutation = useMutation({
    mutationFn: async (target: OrderStatus) => {
      if (!orderId) throw new Error("missing_id");
      return api.admin.orders.transition(orderId, { toStatus: target });
    },
    onSuccess: async () => {
      await refetchAll();
      toast.success(t("orders.detail.success.transition"));
      setPendingTransition(null);
    },
    onError: (err) => {
      // The API surfaces 409 for an invalid transition; we still show a
      // friendly message — the dialog stays open so the operator can read
      // the error and pick a different action.
      if (err instanceof ApiError && err.message) {
        setTransitionError(err.message);
        return;
      }
      setTransitionError(t("orders.detail.error.transition"));
    },
  });

  const onConfirmTransition = React.useCallback(() => {
    if (!pendingTransition) return;
    setTransitionError(null);
    transitionMutation.mutate(pendingTransition);
  }, [pendingTransition, transitionMutation]);

  // ---- Cancel mutation ----------------------------------------------------

  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState("");
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!orderId) throw new Error("missing_id");
      const trimmed = cancelReason.trim();
      return api.admin.orders.cancel(orderId, {
        reason: trimmed.length > 0 ? trimmed : null,
      });
    },
    onSuccess: async () => {
      await refetchAll();
      toast.success(t("orders.detail.success.cancel"));
      setCancelOpen(false);
      setCancelReason("");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.message) {
        setCancelError(err.message);
        return;
      }
      setCancelError(t("orders.detail.error.cancel"));
    },
  });

  // ---- Loading / error states --------------------------------------------

  if (orderQuery.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (orderQuery.isError || !orderQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="self-start">
          <Link to="/pesanan">
            <HugeiconsIcon icon={ArrowLeft02Icon} data-icon />
            <span>{t("orders.detail.back")}</span>
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>{t("common.error")}</AlertTitle>
          <AlertDescription>{t("orders.detail.error.load")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const order = orderQuery.data;
  const allowedTransitions = TRANSITIONS[order.status];
  const canCancel = CANCELLABLE_FROM.has(order.status);
  const isProcessing = transitionMutation.isPending || cancelMutation.isPending;

  return (
    <div className="flex flex-col gap-6">
      {/* Header --------------------------------------------------------- */}
      <header className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="self-start">
          <Link to="/pesanan">
            <HugeiconsIcon icon={ArrowLeft02Icon} data-icon />
            <span>{t("orders.detail.back")}</span>
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">
              {order.orderNumber}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <Badge variant={STATUS_BADGE_VARIANT[order.status]}>
                {t(STATUS_LABEL_KEYS[order.status])}
              </Badge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    {t("orders.detail.placed_at")}:{" "}
                    {shortDateTime(order.createdAt, intlLocale(locale))}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {absoluteDate(order.createdAt, intlLocale(locale))}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">
              {t("orders.detail.total")}
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {formatMoney(order.total, { locale: intlLocale(locale) })}
            </p>
          </div>
        </div>
      </header>

      {/* Live region for in-flight transition / cancel state. Visually
          hidden — toasts handle the visible feedback. */}
      <span className="sr-only" aria-live="polite">
        {isProcessing ? t("orders.detail.action_in_progress") : ""}
      </span>

      {/* Transition + cancel actions ---------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("orders.detail.transitions")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {allowedTransitions.length === 0 && !canCancel ? (
            <p className="text-sm text-muted-foreground">
              {t("orders.detail.transitions.empty")}
            </p>
          ) : null}
          {allowedTransitions.map((target) => (
            <Button
              key={target}
              type="button"
              variant="default"
              size="sm"
              disabled={isProcessing}
              onClick={() => {
                setTransitionError(null);
                setPendingTransition(target);
              }}
            >
              {t(`orders.detail.transitions.to.${target}`)}
            </Button>
          ))}
          {canCancel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isProcessing}
              onClick={() => {
                setCancelError(null);
                setCancelOpen(true);
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} data-icon />
              <span>{t("orders.detail.cancel")}</span>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* Customer + addresses ------------------------------------------ */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("orders.detail.customer")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">
                {t("orders.detail.customer_email")}
              </dt>
              <dd>{order.email}</dd>
              {order.customerId ? (
                <>
                  <dt className="text-muted-foreground">
                    {t("orders.detail.customer_id")}
                  </dt>
                  <dd className="font-mono text-xs">{order.customerId}</dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("orders.detail.shipping_address")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AddressBlock address={order.shippingAddressSnapshot} />
          </CardContent>
        </Card>
        {order.billingAddressSnapshot ? (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                {t("orders.detail.billing_address")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AddressBlock address={order.billingAddressSnapshot} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      {/* Line items ----------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("orders.detail.line_items")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("orders.detail.line_items.title")}</TableHead>
                  <TableHead className="w-32">
                    {t("orders.detail.line_items.sku")}
                  </TableHead>
                  <TableHead className="w-16 text-right">
                    {t("orders.detail.line_items.qty")}
                  </TableHead>
                  <TableHead className="w-32 text-right">
                    {t("orders.detail.line_items.unit_price")}
                  </TableHead>
                  <TableHead className="w-32 text-right">
                    {t("orders.detail.line_items.line_total")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      {item.title || item.sku}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.sku}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.quantity}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(item.unitPrice, {
                        locale: intlLocale(locale),
                      })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(item.lineSubtotal, {
                        locale: intlLocale(locale),
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Totals + meta -------------------------------------------------- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("orders.detail.totals")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <TotalsRow
                label={t("orders.detail.totals.subtotal")}
                value={formatMoney(order.subtotal, {
                  locale: intlLocale(locale),
                })}
              />
              <TotalsRow
                label={t("orders.detail.totals.shipping")}
                value={formatMoney(order.shipping, {
                  locale: intlLocale(locale),
                })}
              />
              <TotalsRow
                label={t("orders.detail.totals.tax")}
                value={formatMoney(order.tax, { locale: intlLocale(locale) })}
              />
              <Separator className="my-2" />
              <TotalsRow
                label={t("orders.detail.totals.total")}
                value={formatMoney(order.total, {
                  locale: intlLocale(locale),
                })}
                emphasis
              />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("orders.detail.shipping_method")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("orders.detail.shipping_method")}
                </dt>
                <dd className="font-mono text-xs">
                  {order.shippingMethodCode}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("orders.detail.payment_method")}
                </dt>
                <dd className="font-mono text-xs">{order.paymentMethod}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Events --------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("orders.detail.events")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EventsTimeline
            events={eventsQuery.data ?? null}
            isPending={eventsQuery.isPending}
            locale={locale}
            t={t}
          />
        </CardContent>
      </Card>

      {/* Confirm-transition dialog ------------------------------------- */}
      <AlertDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTransition(null);
            setTransitionError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("orders.detail.confirm_transition.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingTransition ? (
                <>
                  {t("orders.detail.confirm_transition.body")}
                  <br />
                  <span className="mt-2 inline-block text-foreground">
                    {t(STATUS_LABEL_KEYS[order.status])}{" "}
                    <span aria-hidden="true">→</span>{" "}
                    <strong>{t(STATUS_LABEL_KEYS[pendingTransition])}</strong>
                  </span>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {transitionError ? (
            <Alert variant="destructive">
              <AlertDescription>{transitionError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transitionMutation.isPending}>
              {t("orders.detail.confirm_transition.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Keep the dialog mounted while the request is in flight
                // so the inline error can render under the buttons. We
                // close on success (in `onSuccess`) or via the cancel
                // button on error.
                event.preventDefault();
                onConfirmTransition();
              }}
              disabled={transitionMutation.isPending}
            >
              {transitionMutation.isPending ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("orders.detail.action_in_progress")}</span>
                </>
              ) : (
                t("orders.detail.confirm_transition.confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm-cancel dialog ---------------------------------------- */}
      <AlertDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCancelOpen(false);
            setCancelError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("orders.detail.confirm_cancel.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("orders.detail.confirm_cancel.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="cancel-reason"
              className="text-sm text-muted-foreground"
            >
              {t("orders.detail.cancel_reason_label")}
            </label>
            <Input
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t("orders.detail.cancel_reason_placeholder")}
              maxLength={500}
              disabled={cancelMutation.isPending}
            />
          </div>
          {cancelError ? (
            <Alert variant="destructive">
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              {t("orders.detail.confirm_cancel.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                setCancelError(null);
                cancelMutation.mutate();
              }}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? (
                <>
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon
                    className="animate-spin"
                  />
                  <span>{t("orders.detail.action_in_progress")}</span>
                </>
              ) : (
                t("orders.detail.confirm_cancel.confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------

function AddressBlock({ address }: { address: OrderAddressSnapshot }) {
  return (
    <address className="not-italic text-sm">
      <p className="font-medium">{address.recipientName}</p>
      <p className="text-muted-foreground">
        {[address.addressLine1, address.addressLine2]
          .filter(Boolean)
          .join(", ")}
      </p>
      {/* Region IDs render as raw codes — the catalog lookup module is the
          right place to resolve names; the audit/snapshot is intentionally
          ID-only so a later region rename doesn't rewrite history. */}
      <p className="text-muted-foreground">
        {address.kotaKabupatenId} · {address.postalCode}
      </p>
      <p className="text-muted-foreground">{address.phone}</p>
      {address.notes ? (
        <p className="mt-2 text-xs text-muted-foreground">{address.notes}</p>
      ) : null}
    </address>
  );
}

function TotalsRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        emphasis
          ? "flex justify-between gap-4 font-semibold"
          : "flex justify-between gap-4 text-muted-foreground"
      }
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function EventsTimeline({
  events,
  isPending,
  locale,
  t,
}: {
  events: OrderStatusEvent[] | null;
  isPending: boolean;
  locale: "id" | "en";
  t: (key: string) => string;
}) {
  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("orders.detail.events.empty")}
      </p>
    );
  }

  // Newest first reads more naturally for an audit trail; the API
  // returns oldest-first today (insertion order). We sort defensively.
  const sorted = [...events].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const dtFormat = intlLocale(locale);

  return (
    <ol className="flex flex-col gap-3">
      {sorted.map((event) => (
        <li
          key={event.id}
          className="flex flex-col gap-1 border-l-2 border-muted pl-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {event.fromStatus ? (
              <>
                <Badge variant="outline">
                  {t(`orders.status.${event.fromStatus}`)}
                </Badge>
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              </>
            ) : null}
            <Badge variant={STATUS_BADGE_VARIANT[event.toStatus]}>
              {t(`orders.status.${event.toStatus}`)}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{shortDateTime(event.createdAt, dtFormat)}</span>
            <span aria-hidden="true">·</span>
            <span>{t(ACTOR_LABEL_KEYS[event.actorKind])}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

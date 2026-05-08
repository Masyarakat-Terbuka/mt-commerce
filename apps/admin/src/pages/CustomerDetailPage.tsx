/**
 * Pelanggan detail — read-only view of one customer plus their addresses
 * and recent orders.
 *
 * Why read-only at v0.1:
 *   - Editing email and password requires the auth-side flows (Better Auth
 *     reset, etc.) which the admin does not yet integrate. Surfacing edit
 *     fields here without those flows would let a staff member set fields
 *     that wouldn't take effect on the auth identity.
 *   - Customer creation lives on the storefront sign-up flow per ADR; the
 *     admin would create orphan records without an auth user. That gets
 *     untangled once the auth-side admin flows ship.
 *
 * Two queries fan out from this page:
 *   1. `customers.byId(id)` — returns the customer plus embedded
 *      addresses in one round-trip (the API does the join).
 *   2. `orders.list({ customerId: id })` — recent orders, capped to a
 *      small page so the side panel stays light.
 *
 * If the orders query 4xxs (the customer has no orders, or the API filter
 * is missing in some deployment), we degrade to "no orders yet" rather
 * than blocking the whole detail page on a non-essential block.
 */
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  Mail01Icon,
  SmartPhone01Icon,
  Building01Icon,
  IdentificationIcon,
  Location01Icon,
  StarIcon,
  ShoppingBag01Icon,
} from "@hugeicons/core-free-icons";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  ApiError,
  type CustomerAddress,
  type CustomerWithAddresses,
  type Order,
  type OrderStatus,
} from "@/lib/api";
import { absoluteDate, formatMoney, relativeTime } from "@/lib/format";
import { useLocale, useTranslator } from "@/lib/i18n";

const ORDERS_PREVIEW_LIMIT = 5;

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "customers.orders.status.pending_payment",
  paid: "customers.orders.status.paid",
  fulfilled: "customers.orders.status.fulfilled",
  cancelled: "customers.orders.status.cancelled",
  refunded: "customers.orders.status.refunded",
};

const ORDER_STATUS_VARIANT: Record<
  OrderStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending_payment: "secondary",
  paid: "default",
  fulfilled: "default",
  cancelled: "outline",
  refunded: "destructive",
};

export function CustomerDetailPage() {
  const t = useTranslator();
  const { locale } = useLocale();
  // `strict: false` keeps the typed handle loose. The gated parent route
  // mangles the literal id; matches the pattern used in ProductEditorPage.
  const params = useParams({ strict: false }) as { id?: string };
  const customerId = params.id ?? "";

  const customerQuery = useQuery({
    queryKey: ["admin", "customer", customerId] as const,
    queryFn: () => api.admin.customers.byId(customerId),
    staleTime: 30 * 1000,
  });

  // Orders query — kept independent from the customer fetch so the addresses
  // section renders even when the orders block fails.
  const ordersQuery = useQuery({
    queryKey: [
      "admin",
      "customer",
      customerId,
      "orders",
      { limit: ORDERS_PREVIEW_LIMIT },
    ] as const,
    queryFn: () =>
      api.admin.orders.list({
        customerId,
        page: 1,
        pageSize: ORDERS_PREVIEW_LIMIT,
        locale,
      }),
    staleTime: 30 * 1000,
    // Don't bubble the orders error to the page — let the orders card show
    // an inline message instead. The detail page is still useful without it.
    retry: 1,
  });

  if (customerQuery.isError) {
    const isNotFound =
      customerQuery.error instanceof ApiError &&
      customerQuery.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertTitle>{t("common.error")}</AlertTitle>
          <AlertDescription>
            {isNotFound
              ? t("customers.detail.not_found")
              : t("customers.detail.load_error")}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!customerQuery.data) {
    return <DetailSkeleton />;
  }

  const customer = customerQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <Header customer={customer} locale={locale} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ContactCard customer={customer} />
        <AddressesCard
          addresses={customer.addresses}
          className="lg:col-span-2"
        />
      </div>

      <OrdersCard
        orders={ordersQuery.data?.data}
        total={ordersQuery.data?.total}
        isPending={ordersQuery.isPending}
        isError={ordersQuery.isError}
        customerId={customer.id}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sub-components — kept in this file because they are page-local. Splitting
// them out only pays off once another screen reuses them.
// ----------------------------------------------------------------------------

function BackLink() {
  const t = useTranslator();
  return (
    <Button asChild variant="ghost" size="sm" className="self-start">
      <Link to="/pelanggan">
        <HugeiconsIcon icon={ArrowLeft02Icon} data-icon />
        <span>{t("customers.detail.back")}</span>
      </Link>
    </Button>
  );
}

function Header({
  customer,
  locale,
}: {
  customer: CustomerWithAddresses;
  locale: ReturnType<typeof useLocale>["locale"];
}) {
  const t = useTranslator();
  const displayLabel =
    customer.displayName?.trim().length
      ? customer.displayName
      : customer.email;
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{displayLabel}</h1>
      <p className="text-sm text-muted-foreground">
        {t("customers.detail.joined_prefix")}{" "}
        <span title={absoluteDate(customer.createdAt, locale)}>
          {relativeTime(customer.createdAt, locale)}
        </span>
      </p>
    </div>
  );
}

function ContactCard({ customer }: { customer: CustomerWithAddresses }) {
  const t = useTranslator();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("customers.detail.contact")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <ContactRow icon={Mail01Icon} label={t("customers.columns.email")}>
          <a
            href={`mailto:${customer.email}`}
            className="break-all underline-offset-2 hover:underline"
          >
            {customer.email}
          </a>
        </ContactRow>
        <ContactRow icon={SmartPhone01Icon} label={t("customers.columns.phone")}>
          {customer.phone ? (
            <a
              href={`tel:${customer.phone}`}
              className="underline-offset-2 hover:underline"
            >
              {customer.phone}
            </a>
          ) : (
            <span className="text-muted-foreground">
              {t("customers.detail.no_phone")}
            </span>
          )}
        </ContactRow>
        {customer.companyName ? (
          <ContactRow
            icon={Building01Icon}
            label={t("customers.detail.company")}
          >
            {customer.companyName}
          </ContactRow>
        ) : null}
        {customer.taxIdentifier ? (
          <ContactRow
            icon={IdentificationIcon}
            label={t("customers.detail.tax_id")}
          >
            <span className="font-mono text-xs">{customer.taxIdentifier}</span>
          </ContactRow>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ContactRow({
  icon,
  label,
  children,
}: {
  icon: typeof Mail01Icon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <HugeiconsIcon
        icon={icon}
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}

function AddressesCard({
  addresses,
  className,
}: {
  addresses: CustomerAddress[];
  className?: string;
}) {
  const t = useTranslator();
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">
          {t("customers.detail.addresses")}
        </CardTitle>
        <CardDescription>
          {t("customers.detail.addresses_subhead")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {addresses.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("customers.detail.no_addresses")}</EmptyTitle>
              <EmptyDescription>
                {t("customers.detail.no_addresses_body")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {addresses.map((address, index) => (
              <li key={address.id}>
                <AddressRow address={address} />
                {index < addresses.length - 1 ? (
                  <Separator className="mt-3" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AddressRow({ address }: { address: CustomerAddress }) {
  const t = useTranslator();
  // Region rows render `name ?? id` — names come from the API's read-time
  // JOIN against the four region tables. The fall-back to the BPS code
  // matters for two cases:
  //   - older API deployments that have not yet shipped the JOIN
  //   - addresses pointing at a region row that was pruned (the JOIN
  //     surfaces `undefined` and the operator still sees the raw code,
  //     which is enough to debug the dangling reference).
  return (
    <div className="flex items-start gap-2">
      <HugeiconsIcon
        icon={Location01Icon}
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{address.recipientName}</span>
          <Badge variant="outline" className="capitalize">
            {address.kind === "shipping"
              ? t("customers.detail.kind_shipping")
              : t("customers.detail.kind_billing")}
          </Badge>
          {address.isDefaultShipping ? (
            <Badge variant="secondary" className="gap-1">
              <HugeiconsIcon icon={StarIcon} className="size-3" />
              <span>{t("customers.detail.default_shipping")}</span>
            </Badge>
          ) : null}
          {address.isDefaultBilling ? (
            <Badge variant="secondary" className="gap-1">
              <HugeiconsIcon icon={StarIcon} className="size-3" />
              <span>{t("customers.detail.default_billing")}</span>
            </Badge>
          ) : null}
        </div>
        <div className="text-sm text-muted-foreground">{address.phone}</div>
        <div className="text-sm">
          {address.addressLine1}
          {address.addressLine2 ? `, ${address.addressLine2}` : ""}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-4">
          <RegionCell
            label={t("customers.detail.provinsi")}
            value={address.provinsiName ?? address.provinsiId}
            hasName={address.provinsiName !== undefined}
          />
          <RegionCell
            label={t("customers.detail.kota")}
            value={address.kotaKabupatenName ?? address.kotaKabupatenId}
            hasName={address.kotaKabupatenName !== undefined}
          />
          <RegionCell
            label={t("customers.detail.kecamatan")}
            value={address.kecamatanName ?? address.kecamatanId}
            hasName={address.kecamatanName !== undefined}
          />
          <RegionCell
            label={t("customers.detail.kelurahan")}
            value={
              address.kelurahanName ?? address.kelurahanId ?? "—"
            }
            hasName={address.kelurahanName !== undefined}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {t("customers.detail.postal_code")}:{" "}
          <span className="font-mono">{address.postalCode}</span>
        </div>
        {address.notes ? (
          <div className="text-xs italic text-muted-foreground">
            {address.notes}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RegionCell({
  label,
  value,
  hasName,
}: {
  label: string;
  value: string;
  /**
   * When the resolved region name is available we render it as plain
   * text; the BPS-id fall-back keeps the monospace treatment so an
   * operator can immediately see "this is an unresolved code, not a
   * name".
   */
  hasName: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[0.6875rem] uppercase tracking-wide">{label}</span>
      <span className={hasName ? undefined : "font-mono"}>{value}</span>
    </div>
  );
}

function OrdersCard({
  orders,
  total,
  isPending,
  isError,
  customerId,
}: {
  orders: Order[] | undefined;
  total: number | undefined;
  isPending: boolean;
  isError: boolean;
  customerId: string;
}) {
  const t = useTranslator();
  const { locale } = useLocale();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">
            {t("customers.detail.orders")}
          </CardTitle>
          {total !== undefined && total > 0 ? (
            <CardDescription>
              {t("customers.detail.orders_count").replace(
                "{n}",
                String(total),
              )}
            </CardDescription>
          ) : null}
        </div>
        {/*
         * Link to /pesanan with the customerId pre-filled. The orders screen
         * is still ComingSoon today; we keep the link here so the contract
         * stays stable once that screen lands. A staff member who needs the
         * full list can fall back to the URL directly.
         */}
        <Button asChild variant="outline" size="sm">
          <Link
            to="/pesanan"
            search={{ customer: customerId } as Record<string, string>}
          >
            <HugeiconsIcon icon={ShoppingBag01Icon} data-icon />
            <span>{t("customers.detail.view_all_orders")}</span>
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t("common.error")}</AlertTitle>
            <AlertDescription>
              {t("customers.detail.orders_error")}
            </AlertDescription>
          </Alert>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : orders && orders.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("customers.detail.order.number")}</TableHead>
                <TableHead className="w-32">
                  {t("customers.detail.order.status")}
                </TableHead>
                <TableHead className="w-32 text-right">
                  {t("customers.detail.order.total")}
                </TableHead>
                <TableHead className="w-40">
                  {t("customers.detail.order.placed_at")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">
                    {order.orderNumber}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ORDER_STATUS_VARIANT[order.status]}>
                      {t(ORDER_STATUS_LABEL[order.status])}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(order.total, locale)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {relativeTime(order.createdAt, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("customers.detail.no_orders")}</EmptyTitle>
              <EmptyDescription>
                {t("customers.detail.no_orders_body")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-7 w-64" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full lg:col-span-2" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

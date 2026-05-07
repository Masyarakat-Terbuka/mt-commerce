/**
 * Drizzle row → orders domain type mappers.
 *
 * Two collapses happen here, mirroring the catalog mappers:
 *
 *   1. The two-column `(amount, currency)` storage shape becomes a single
 *      `Money` value. The `orders` row stores one currency on the
 *      parent and bigint amount columns next to it; `order_items` carries
 *      its own `unit_price_currency` (defense-in-depth — should always
 *      match the order's currency).
 *
 *   2. The locale-keyed `title_translations` JSONB column on
 *      `order_items` is flattened to a plain string for the requested
 *      locale, falling back through the chain documented in the catalog
 *      module's `i18n.ts`. We re-use the catalog helper rather than
 *      re-implementing the fallback so a single source of truth governs
 *      ADR-0010 behaviour across modules.
 */
import type { Money } from "@mt-commerce/core/money";
import type {
  OrderItemRow,
  OrderRow,
  OrderStatusHistoryRow,
} from "../../db/schema/index.js";
import { DEFAULT_LOCALE, resolveTranslations } from "../catalog/i18n.js";
import type {
  Order,
  OrderActorKind,
  OrderAddressSnapshot,
  OrderItem,
  OrderStatus,
  OrderStatusEvent,
} from "./types.js";

function snapshotAsAddress(raw: unknown): OrderAddressSnapshot {
  // The JSONB column is loosely typed at the Drizzle layer; the writer
  // (orders service) is the single producer and always emits the full
  // shape. A malformed snapshot would surface as a programming error in
  // tests rather than a silent runtime gap.
  return raw as OrderAddressSnapshot;
}

export function toOrderItem(
  row: OrderItemRow,
  locale: string = DEFAULT_LOCALE,
): OrderItem {
  const unitPrice: Money = {
    amount: row.unitPriceAmount,
    currency: row.unitPriceCurrency,
  };
  const lineSubtotal: Money = {
    amount: row.lineSubtotalAmount,
    currency: row.unitPriceCurrency,
  };

  // `title_translations` is the locale-keyed shape from ADR-0010. The
  // catalog resolver returns `{ title: string }` — collapse to a flat
  // string here. Empty when no translation is available; the wire shape
  // surfaces empty rather than `null` so storefront rendering does not
  // have to branch.
  const resolved = resolveTranslations<"title">(
    row.titleTranslations as Record<string, Partial<Record<"title", string>>>,
    locale,
  );
  const title = resolved.title ?? "";

  return {
    id: row.id,
    orderId: row.orderId,
    variantId: row.variantId,
    sku: row.sku,
    title,
    quantity: row.quantity,
    unitPrice,
    lineSubtotal,
    createdAt: row.createdAt,
  };
}

export function toOrder(
  row: OrderRow,
  items: OrderItemRow[],
  locale: string = DEFAULT_LOCALE,
): Order {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    customerId: row.customerId ?? null,
    email: row.email,
    currency: row.currency,
    status: row.status as OrderStatus,
    subtotal: { amount: row.subtotalAmount, currency: row.currency },
    tax: { amount: row.taxAmount, currency: row.currency },
    taxRateCode: row.taxRateCode ?? null,
    taxRateBasisPoints: row.taxRateBasisPoints ?? null,
    shipping: { amount: row.shippingAmount, currency: row.currency },
    shippingMethodCode: row.shippingMethodCode,
    total: { amount: row.totalAmount, currency: row.currency },
    shippingAddressSnapshot: snapshotAsAddress(row.shippingAddressSnapshot),
    billingAddressSnapshot: row.billingAddressSnapshot
      ? snapshotAsAddress(row.billingAddressSnapshot)
      : null,
    paymentMethod: row.paymentMethod,
    items: items.map((it) => toOrderItem(it, locale)),
    paidAt: row.paidAt ?? null,
    fulfilledAt: row.fulfilledAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    refundedAt: row.refundedAt ?? null,
    cancellationReason: row.cancellationReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toOrderStatusEvent(
  row: OrderStatusHistoryRow,
): OrderStatusEvent {
  // `details` is jsonb; Drizzle types it as `unknown`. We trust the
  // writer (the service) to produce a plain record.
  const details = (row.details ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    orderId: row.orderId,
    fromStatus: (row.fromStatus as OrderStatus | null) ?? null,
    toStatus: row.toStatus as OrderStatus,
    actorKind: row.actorKind as OrderActorKind,
    actorId: row.actorId ?? null,
    details,
    createdAt: row.createdAt,
  };
}

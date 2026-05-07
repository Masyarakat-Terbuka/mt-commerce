/**
 * Wire-shape helpers — convert orders domain types to JSON-safe payloads.
 *
 * Same rationale as the cart/checkout wire layers:
 *   - `Date` → ISO 8601 string
 *   - `Money` → `MoneyJSON` ({ amount: "<decimal>", currency }) per ADR-0007
 *   - Optional fields render as `null`, never absent
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Order,
  OrderActorKind,
  OrderAddressSnapshot,
  OrderItem,
  OrderStatus,
  OrderStatusEvent,
} from "../types.js";

export interface WireOrderItem {
  id: string;
  orderId: string;
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: MoneyJSON;
  lineSubtotal: MoneyJSON;
  createdAt: string;
}

export interface WireOrder {
  id: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  status: OrderStatus;
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  taxRateCode: string | null;
  taxRateBasisPoints: number | null;
  shipping: MoneyJSON;
  shippingMethodCode: string;
  total: MoneyJSON;
  shippingAddressSnapshot: OrderAddressSnapshot;
  billingAddressSnapshot: OrderAddressSnapshot | null;
  paymentMethod: string;
  items: WireOrderItem[];
  paidAt: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireOrderStatusEvent {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorKind: OrderActorKind;
  actorId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

function toWireItem(item: OrderItem): WireOrderItem {
  return {
    id: item.id,
    orderId: item.orderId,
    variantId: item.variantId,
    sku: item.sku,
    title: item.title,
    quantity: item.quantity,
    unitPrice: moneyToJSON(item.unitPrice),
    lineSubtotal: moneyToJSON(item.lineSubtotal),
    createdAt: item.createdAt.toISOString(),
  };
}

export function toWireOrder(order: Order): WireOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    email: order.email,
    currency: order.currency,
    status: order.status,
    subtotal: moneyToJSON(order.subtotal),
    tax: moneyToJSON(order.tax),
    taxRateCode: order.taxRateCode,
    taxRateBasisPoints: order.taxRateBasisPoints,
    shipping: moneyToJSON(order.shipping),
    shippingMethodCode: order.shippingMethodCode,
    total: moneyToJSON(order.total),
    shippingAddressSnapshot: order.shippingAddressSnapshot,
    billingAddressSnapshot: order.billingAddressSnapshot,
    paymentMethod: order.paymentMethod,
    items: order.items.map(toWireItem),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    fulfilledAt: order.fulfilledAt ? order.fulfilledAt.toISOString() : null,
    cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
    refundedAt: order.refundedAt ? order.refundedAt.toISOString() : null,
    cancellationReason: order.cancellationReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function toWireOrderStatusEvent(
  event: OrderStatusEvent,
): WireOrderStatusEvent {
  return {
    id: event.id,
    orderId: event.orderId,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorKind: event.actorKind,
    actorId: event.actorId,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

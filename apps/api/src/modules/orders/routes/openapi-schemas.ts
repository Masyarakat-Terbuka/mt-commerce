/**
 * Shared OpenAPI wire-shape schemas for the orders routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reference the same
 * JSON shape for orders / order items / order status events, so we
 * register each component once.
 */
import { z } from "@hono/zod-openapi";
import { MoneyJson, paginated } from "../../../lib/openapi-shared.js";

const OrderStatusEnum = z.enum([
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
]);

const OrderActorKindEnum = z.enum(["system", "staff", "customer"]);

const OrderAddressSnapshotWire = z
  .object({
    id: z.string(),
    customerId: z.string(),
    kind: z.enum(["shipping", "billing"]),
    recipientName: z.string(),
    phone: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    provinsiId: z.string(),
    kotaKabupatenId: z.string(),
    kecamatanId: z.string(),
    kelurahanId: z.string().nullable(),
    // Resolved region names captured AT WRITE TIME (snapshot semantics —
    // a later region rename does not rewrite past orders). Optional so
    // pre-existing orders that lack the names parse cleanly; UI clients
    // fall back to the BPS id field.
    provinsiName: z.string().optional(),
    kotaKabupatenName: z.string().optional(),
    kecamatanName: z.string().optional(),
    kelurahanName: z.string().optional(),
    postalCode: z.string(),
    notes: z.string().nullable(),
  })
  .openapi("OrderAddressSnapshot");

const OrderItemWire = z
  .object({
    id: z.string(),
    orderId: z.string(),
    variantId: z.string(),
    sku: z.string(),
    title: z.string(),
    quantity: z.number().int(),
    unitPrice: MoneyJson,
    lineSubtotal: MoneyJson,
    createdAt: z.string(),
  })
  .openapi("OrderItem");

export const OrderWire = z
  .object({
    id: z.string(),
    orderNumber: z.string(),
    customerId: z.string().nullable(),
    email: z.string(),
    currency: z.string(),
    status: OrderStatusEnum,
    subtotal: MoneyJson,
    tax: MoneyJson,
    taxRateCode: z.string().nullable(),
    taxRateBasisPoints: z.number().int().nullable(),
    shipping: MoneyJson,
    shippingMethodCode: z.string(),
    total: MoneyJson,
    shippingAddressSnapshot: OrderAddressSnapshotWire,
    billingAddressSnapshot: OrderAddressSnapshotWire.nullable(),
    paymentMethod: z.string(),
    items: z.array(OrderItemWire),
    paidAt: z.string().nullable(),
    fulfilledAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    refundedAt: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Order");

export const OrderStatusEventWire = z
  .object({
    id: z.string(),
    orderId: z.string(),
    fromStatus: OrderStatusEnum.nullable(),
    toStatus: OrderStatusEnum,
    actorKind: OrderActorKindEnum,
    actorId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("OrderStatusEvent");

export const PaginatedOrderWire = paginated(OrderWire).openapi(
  "PaginatedOrder",
);

export const OrderEventListEnvelope = z
  .object({ data: z.array(OrderStatusEventWire) })
  .openapi("OrderStatusEventList");

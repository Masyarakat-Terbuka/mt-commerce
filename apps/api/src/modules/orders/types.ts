/**
 * Orders module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the catalog/cart/checkout modules:
 *
 *   1. Domain types (`Order`, `OrderItem`, `OrderStatus`,
 *      `OrderStatusEvent`, `OrderAddressSnapshot`, `Paginated<T>`) — clean
 *      shapes the rest of the system consumes. Money is a `Money` value
 *      object; dates are `Date` instances; the route layer converts to
 *      ISO strings on the way out. Translatable item titles are exposed
 *      as a flat string here — the JSONB `title_translations` column is
 *      resolved by the mapper layer per ADR-0010.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for
 *      request shape; surfaced through the standard validation_error
 *      envelope.
 */
import { z } from "zod";
import type { Money } from "@mt-commerce/core/money";
import { ALL_ORDER_STATUSES, type OrderStatus } from "./state.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type { OrderStatus };

export type OrderActorKind = "system" | "staff" | "customer";

/**
 * Address shape captured at order time. Mirrors the
 * `OrderIntentAddress` shape from the checkout module so a snapshot can
 * be lifted across the boundary unchanged.
 *
 * Region names (`provinsiName` / `kotaKabupatenName` / `kecamatanName` /
 * `kelurahanName`) are SNAPSHOTTED AT WRITE TIME — when the orders
 * service materialises an order, it resolves the four region names
 * once and stores them in the JSONB blob alongside the BPS ids. This
 * preserves the audit-grade "the address as it was when the customer
 * placed the order" property: a later region rename in the BPS dataset
 * does not retroactively rewrite past orders.
 *
 * The fields are optional because:
 *
 *   - Orders created BEFORE this change have no names in their JSON
 *     blob; the wire layer surfaces them as `undefined` and the UI
 *     falls back to the BPS code via `provinsiName ?? provinsiId`.
 *
 *   - A region row missing at write time (a stale FK on the source
 *     address) leaves the corresponding name out rather than fabricating
 *     one. The other levels still get populated.
 */
export interface OrderAddressSnapshot {
  id: string;
  customerId: string;
  kind: "shipping" | "billing";
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  provinsiId: string;
  kotaKabupatenId: string;
  kecamatanId: string;
  kelurahanId: string | null;
  provinsiName?: string;
  kotaKabupatenName?: string;
  kecamatanName?: string;
  kelurahanName?: string;
  postalCode: string;
  notes: string | null;
}

export interface OrderItem {
  id: string;
  orderId: string;
  variantId: string;
  sku: string;
  /**
   * Resolved-locale title at read time. The persisted snapshot is the
   * full `translations` JSONB; the mapper flattens to the requested
   * locale. Empty string when no translation is available.
   */
  title: string;
  quantity: number;
  unitPrice: Money;
  /** `unitPrice * quantity`. */
  lineSubtotal: Money;
  createdAt: Date;
}

export interface Order {
  id: string;
  /** Customer-facing handle, e.g. `ORD-2026-000123`. */
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  status: OrderStatus;
  subtotal: Money;
  tax: Money;
  taxRateCode: string | null;
  taxRateBasisPoints: number | null;
  shipping: Money;
  shippingMethodCode: string;
  total: Money;
  shippingAddressSnapshot: OrderAddressSnapshot;
  billingAddressSnapshot: OrderAddressSnapshot | null;
  paymentMethod: string;
  items: OrderItem[];
  paidAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderStatusEvent {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorKind: OrderActorKind;
  actorId: string | null;
  /** Small JSON blob; do NOT carry PII or full address payloads here. */
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const orderStatusSchema = z.enum(
  ALL_ORDER_STATUSES as readonly [OrderStatus, ...OrderStatus[]],
);

const orderActorKindSchema = z.enum(["system", "staff", "customer"]);

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Admin transition input. The `details` blob is forwarded into the audit
 * row verbatim so plug-in payment / fulfillment surfaces can attach
 * arbitrary context (provider tx id, tracking code) without us having
 * to carve out a column per integration.
 */
export const transitionOrderSchema = z.object({
  toStatus: orderStatusSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});
export type TransitionOrderInput = z.infer<typeof transitionOrderSchema>;

export const cancelOrderSchema = z.object({
  /** Free-text reason; trimmed and folded to null when only whitespace. */
  reason: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return null;
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Admin list query. Filter by status, customer, email, and a creation
 * date range. `from`/`to` are RFC 3339 timestamps the route layer parses
 * into `Date` instances.
 */
export const listOrdersQuerySchema = z
  .object({
    status: orderStatusSchema.optional(),
    customerId: z.string().min(1).max(100).optional(),
    email: z.string().email().max(255).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  })
  .refine(
    (q) =>
      !(q.createdFrom && q.createdTo && q.createdFrom > q.createdTo),
    {
      message: "createdFrom must be before createdTo",
      path: ["createdTo"],
    },
  );
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

/** Storefront `me/orders` pagination — narrower than the admin shape. */
export const listMyOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListMyOrdersQuery = z.infer<typeof listMyOrdersQuerySchema>;

// Re-export for tests + service consumers that want the validation type
// without re-parsing through Zod.
export { orderActorKindSchema, orderStatusSchema };

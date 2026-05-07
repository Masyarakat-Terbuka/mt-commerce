/**
 * Shared OpenAPI wire-shape schemas for the checkout routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reference the same JSON
 * shape for checkouts and order intents, so we register each component once.
 */
import { z } from "@hono/zod-openapi";
import { MoneyJson, paginated } from "../../../lib/openapi-shared.js";

const CheckoutStateEnum = z.enum([
  "pending",
  "awaiting_shipping",
  "awaiting_payment",
  "completed",
  "failed",
]);

export const CheckoutWire = z
  .object({
    id: z.string(),
    cartId: z.string(),
    customerId: z.string().nullable(),
    state: CheckoutStateEnum,
    shippingAddressId: z.string().nullable(),
    billingAddressId: z.string().nullable(),
    email: z.string().nullable(),
    shippingMethodCode: z.string().nullable(),
    shippingAmount: MoneyJson.nullable(),
    paymentMethod: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    idempotencyKey: z.string().nullable(),
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Checkout");

export const CheckoutEventWire = z
  .object({
    id: z.string(),
    checkoutId: z.string(),
    fromState: CheckoutStateEnum.nullable(),
    toState: CheckoutStateEnum,
    details: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("CheckoutEvent");

const OrderIntentAddressWire = z
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
    postalCode: z.string(),
    notes: z.string().nullable(),
  })
  .openapi("OrderIntentAddress");

const OrderIntentLineWire = z
  .object({
    variantId: z.string(),
    quantity: z.number().int(),
    unitPrice: MoneyJson,
  })
  .openapi("OrderIntentLine");

const OrderIntentTotalsWire = z
  .object({
    subtotal: MoneyJson,
    tax: MoneyJson,
    shipping: MoneyJson,
    total: MoneyJson,
  })
  .openapi("OrderIntentTotals");

export const OrderIntentWire = z
  .object({
    id: z.string(),
    checkoutId: z.string(),
    cartSnapshot: z.array(OrderIntentLineWire),
    totalsSnapshot: OrderIntentTotalsWire,
    shippingAddressSnapshot: OrderIntentAddressWire,
    billingAddressSnapshot: OrderIntentAddressWire.nullable(),
    email: z.string().email(),
    shippingMethodCode: z.string(),
    paymentMethod: z.string(),
    createdAt: z.string(),
  })
  .openapi("OrderIntent");

export const CompleteCheckoutResponseWire = z
  .object({
    checkout: CheckoutWire,
    orderIntent: OrderIntentWire,
  })
  .openapi("CompleteCheckoutResponse");

export const PaginatedCheckoutWire = paginated(CheckoutWire).openapi(
  "PaginatedCheckout",
);

export const CheckoutEventListEnvelope = z
  .object({ data: z.array(CheckoutEventWire) })
  .openapi("CheckoutEventList");

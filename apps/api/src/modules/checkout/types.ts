/**
 * Checkout module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the cart and customer modules:
 *
 *   1. Domain types (`Checkout`, `CheckoutEvent`, `OrderIntent`,
 *      `Paginated<T>`) — clean shapes the rest of the system consumes.
 *      Money is a `Money` value object; dates are `Date` instances; the
 *      route layer converts to ISO strings on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for
 *      request shape; surfaced through the standard validation_error envelope.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES, type Money } from "@mt-commerce/core/money";
import type { CheckoutState } from "./state.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type { CheckoutState };

export interface Checkout {
  id: string;
  cartId: string;
  customerId: string | null;
  state: CheckoutState;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  email: string | null;
  shippingMethodCode: string | null;
  /** Captured at shipping selection. Currency mirrors the cart's currency. */
  shippingAmount: Money | null;
  paymentMethod: string | null;
  cancellationReason: string | null;
  idempotencyKey: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckoutEvent {
  id: string;
  checkoutId: string;
  fromState: CheckoutState | null;
  toState: CheckoutState;
  /** Small JSON blob; do NOT carry PII or full address payloads here. */
  details: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Snapshot of a single cart line item taken at completion time. The Order
 * module consumes this as-is when materializing `order_items`.
 */
export interface OrderIntentLine {
  variantId: string;
  quantity: number;
  unitPrice: Money;
}

export interface OrderIntentTotals {
  subtotal: Money;
  tax: Money;
  shipping: Money;
  total: Money;
}

/**
 * Full address payload captured at completion. We snapshot the whole record
 * (not just the FK) so subsequent customer edits cannot retroactively
 * rewrite the order.
 */
export interface OrderIntentAddress {
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
  postalCode: string;
  notes: string | null;
}

export interface OrderIntent {
  id: string;
  checkoutId: string;
  cartSnapshot: OrderIntentLine[];
  totalsSnapshot: OrderIntentTotals;
  shippingAddressSnapshot: OrderIntentAddress;
  billingAddressSnapshot: OrderIntentAddress | null;
  email: string;
  shippingMethodCode: string;
  paymentMethod: string;
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

const knownCurrencySet = new Set<string>(KNOWN_CURRENCIES);

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" })
  .refine((code) => knownCurrencySet.has(code), {
    message: `currency must be one of: ${[...KNOWN_CURRENCIES].sort().join(", ")}`,
  });

/**
 * Money input shape: `{ amount: "<decimal-string>", currency: "<ISO>" }`.
 * Mirrors the wire shape (per ADR-0007) so storefront clients can pass the
 * value through without translation. The string form preserves bigint
 * precision; the boundary parses to a `bigint`.
 */
const moneyInputSchema = z.object({
  amount: z
    .string()
    .regex(/^-?\d+$/, { message: "amount must be an integer string" }),
  currency: currencySchema,
});

const checkoutStateSchema = z.enum([
  "pending",
  "awaiting_shipping",
  "awaiting_payment",
  "completed",
  "failed",
]);

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const startCheckoutSchema = z.object({
  cartId: z.string().min(1).max(100),
  /**
   * Required for guest checkouts (no `customerId` on the cart). The service
   * cross-checks this against the cart and rejects the call if the cart is
   * already bound to a customer with a different email.
   */
  email: z.string().email().max(255).optional(),
});
export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;

export const setAddressesSchema = z
  .object({
    shippingAddressId: z.string().min(1).max(100),
    billingAddressId: z.string().min(1).max(100).nullable().optional(),
  });
export type SetAddressesInput = z.infer<typeof setAddressesSchema>;

export const setShippingSchema = z.object({
  shippingMethodCode: z.string().min(1).max(100),
  shippingAmount: moneyInputSchema,
});
export type SetShippingInput = z.infer<typeof setShippingSchema>;

export const completeCheckoutSchema = z.object({
  paymentMethod: z.string().min(1).max(100),
});
export type CompleteCheckoutInput = z.infer<typeof completeCheckoutSchema>;

export const cancelCheckoutSchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .optional();
export type CancelCheckoutInput = z.infer<typeof cancelCheckoutSchema>;

// ---------------------------------------------------------------------------
// List query (admin)
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listCheckoutsQuerySchema = z.object({
  state: checkoutStateSchema.optional(),
  customerId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListCheckoutsQuery = z.infer<typeof listCheckoutsQuerySchema>;

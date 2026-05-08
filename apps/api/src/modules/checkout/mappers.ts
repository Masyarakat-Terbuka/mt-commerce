/**
 * Drizzle row → checkout domain type mappers.
 *
 * Same pattern as the cart and customer mappers: total mapping, no business
 * logic. The DB stores `(shipping_amount, shipping_currency)` as two columns;
 * the domain collapses them into a `Money | null` value object. Snapshot
 * fields on `order_intents` are stored as `jsonb`; we narrow them to
 * structural domain types here.
 */
import type {
  CheckoutEventRow,
  CheckoutRow,
  OrderIntentRow,
} from "../../db/schema/index.js";
import type { CheckoutState } from "./state.js";
import type {
  Checkout,
  CheckoutEvent,
  OrderIntent,
  OrderIntentAddress,
  OrderIntentLine,
  OrderIntentTotals,
} from "./types.js";

export function toCheckout(row: CheckoutRow): Checkout {
  // Shipping money: present iff both columns are populated. Stored as two
  // columns so the database remains canonical; the domain type prefers a
  // single value-object.
  const shippingAmount =
    row.shippingAmount !== null && row.shippingCurrency !== null
      ? {
          amount: row.shippingAmount,
          currency: row.shippingCurrency,
        }
      : null;

  return {
    id: row.id,
    cartId: row.cartId,
    customerId: row.customerId ?? null,
    state: row.state as CheckoutState,
    shippingAddressId: row.shippingAddressId ?? null,
    billingAddressId: row.billingAddressId ?? null,
    email: row.email ?? null,
    shippingMethodCode: row.shippingMethodCode ?? null,
    shippingAmount,
    paymentMethod: row.paymentMethod ?? null,
    cancellationReason: row.cancellationReason ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCheckoutEvent(row: CheckoutEventRow): CheckoutEvent {
  // `details` is jsonb; Drizzle types it as `unknown`. We trust the writer
  // to produce a plain record (the service-side helpers always do); a
  // non-object payload would be a programming error caught in tests.
  const details = (row.details ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    checkoutId: row.checkoutId,
    fromState: (row.fromState as CheckoutState | null) ?? null,
    toState: row.toState as CheckoutState,
    details,
    createdAt: row.createdAt,
  };
}

/**
 * `order_intents.cart_snapshot` is stored as JSON. Inputs to the writer are
 * always shaped `{ variantId, quantity, unitPrice: { amount: bigint } }`;
 * we recover the bigint here so consumers see a native `Money` value.
 */
function toOrderIntentLine(raw: unknown): OrderIntentLine {
  const obj = raw as {
    variantId: string;
    quantity: number;
    unitPrice: { amount: string | number | bigint; currency: string };
  };
  return {
    variantId: obj.variantId,
    quantity: obj.quantity,
    unitPrice: {
      amount: BigInt(obj.unitPrice.amount),
      currency: obj.unitPrice.currency,
    },
  };
}

function toOrderIntentTotals(raw: unknown): OrderIntentTotals {
  const obj = raw as Record<
    "subtotal" | "tax" | "shipping" | "total",
    { amount: string | number | bigint; currency: string }
  > & {
    // Optional on read for forward compatibility with snapshots written
    // before the rate metadata was captured. The orders module collapses
    // missing → null at materialisation time.
    taxRateCode?: string | null;
    taxRateBasisPoints?: number | null;
  };
  return {
    subtotal: { amount: BigInt(obj.subtotal.amount), currency: obj.subtotal.currency },
    tax: { amount: BigInt(obj.tax.amount), currency: obj.tax.currency },
    shipping: {
      amount: BigInt(obj.shipping.amount),
      currency: obj.shipping.currency,
    },
    total: { amount: BigInt(obj.total.amount), currency: obj.total.currency },
    taxRateCode: obj.taxRateCode ?? null,
    taxRateBasisPoints: obj.taxRateBasisPoints ?? null,
  };
}

function toOrderIntentAddress(raw: unknown): OrderIntentAddress {
  return raw as OrderIntentAddress;
}

export function toOrderIntent(row: OrderIntentRow): OrderIntent {
  const lines = (row.cartSnapshot as unknown as unknown[]).map(toOrderIntentLine);
  return {
    id: row.id,
    checkoutId: row.checkoutId,
    cartSnapshot: lines,
    totalsSnapshot: toOrderIntentTotals(row.totalsSnapshot),
    shippingAddressSnapshot: toOrderIntentAddress(row.shippingAddressSnapshot),
    billingAddressSnapshot: row.billingAddressSnapshot
      ? toOrderIntentAddress(row.billingAddressSnapshot)
      : null,
    email: row.email,
    shippingMethodCode: row.shippingMethodCode,
    paymentMethod: row.paymentMethod,
    createdAt: row.createdAt,
  };
}

/**
 * Wire-shape helpers — convert checkout domain types to JSON-safe payloads.
 *
 * Same rationale as the cart wire layer:
 *   - `Date` → ISO 8601 string
 *   - `Money` → `MoneyJSON` ({ amount: "<decimal>", currency }) per ADR-0007
 *   - Optional fields render as `null`, never absent
 *
 * `WireOrderIntent` carries the snapshots as the structural shape the
 * future Order module will consume. We deliberately surface the snapshot
 * fields so admin tooling can render the captured cart/totals/addresses
 * without extra calls.
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Checkout,
  CheckoutEvent,
  CheckoutState,
  OrderIntent,
  OrderIntentAddress,
  OrderIntentLine,
  OrderIntentTotals,
} from "../types.js";

export interface WireCheckout {
  id: string;
  cartId: string;
  customerId: string | null;
  state: CheckoutState;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  email: string | null;
  shippingMethodCode: string | null;
  shippingAmount: MoneyJSON | null;
  paymentMethod: string | null;
  cancellationReason: string | null;
  idempotencyKey: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WireCheckoutEvent {
  id: string;
  checkoutId: string;
  fromState: CheckoutState | null;
  toState: CheckoutState;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface WireOrderIntentLine {
  variantId: string;
  quantity: number;
  unitPrice: MoneyJSON;
}

export interface WireOrderIntentTotals {
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  shipping: MoneyJSON;
  total: MoneyJSON;
}

export interface WireOrderIntent {
  id: string;
  checkoutId: string;
  cartSnapshot: WireOrderIntentLine[];
  totalsSnapshot: WireOrderIntentTotals;
  shippingAddressSnapshot: OrderIntentAddress;
  billingAddressSnapshot: OrderIntentAddress | null;
  email: string;
  shippingMethodCode: string;
  paymentMethod: string;
  createdAt: string;
}

export function toWireCheckout(checkout: Checkout): WireCheckout {
  return {
    id: checkout.id,
    cartId: checkout.cartId,
    customerId: checkout.customerId,
    state: checkout.state,
    shippingAddressId: checkout.shippingAddressId,
    billingAddressId: checkout.billingAddressId,
    email: checkout.email,
    shippingMethodCode: checkout.shippingMethodCode,
    shippingAmount: checkout.shippingAmount
      ? moneyToJSON(checkout.shippingAmount)
      : null,
    paymentMethod: checkout.paymentMethod,
    cancellationReason: checkout.cancellationReason,
    idempotencyKey: checkout.idempotencyKey,
    expiresAt: checkout.expiresAt.toISOString(),
    createdAt: checkout.createdAt.toISOString(),
    updatedAt: checkout.updatedAt.toISOString(),
  };
}

export function toWireCheckoutEvent(event: CheckoutEvent): WireCheckoutEvent {
  return {
    id: event.id,
    checkoutId: event.checkoutId,
    fromState: event.fromState,
    toState: event.toState,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

function toWireLine(line: OrderIntentLine): WireOrderIntentLine {
  return {
    variantId: line.variantId,
    quantity: line.quantity,
    unitPrice: moneyToJSON(line.unitPrice),
  };
}

function toWireTotals(totals: OrderIntentTotals): WireOrderIntentTotals {
  return {
    subtotal: moneyToJSON(totals.subtotal),
    tax: moneyToJSON(totals.tax),
    shipping: moneyToJSON(totals.shipping),
    total: moneyToJSON(totals.total),
  };
}

export function toWireOrderIntent(intent: OrderIntent): WireOrderIntent {
  return {
    id: intent.id,
    checkoutId: intent.checkoutId,
    cartSnapshot: intent.cartSnapshot.map(toWireLine),
    totalsSnapshot: toWireTotals(intent.totalsSnapshot),
    shippingAddressSnapshot: intent.shippingAddressSnapshot,
    billingAddressSnapshot: intent.billingAddressSnapshot,
    email: intent.email,
    shippingMethodCode: intent.shippingMethodCode,
    paymentMethod: intent.paymentMethod,
    createdAt: intent.createdAt.toISOString(),
  };
}

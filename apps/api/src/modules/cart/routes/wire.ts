/**
 * Wire-shape helpers — convert cart domain types to JSON-safe payloads.
 *
 * Same rationale as the catalog/customer wire layers:
 *   - `Date` → ISO 8601 string
 *   - `Money` → `MoneyJSON` ({ amount: "<decimal>", currency }) per ADR-0007
 *   - Optional fields render as `null`, never absent
 *
 * `WireCart` carries a `totals` block precomputed by the route layer so
 * clients see the breakdown in the same response without a follow-up call.
 * The route handlers call `service.getTotals(cart)` and embed the result.
 */
import { toJSON as moneyToJSON, type MoneyJSON } from "@mt-commerce/core/money";
import type {
  Cart,
  CartItem,
  CartStatus,
  CartTotals,
} from "../types.js";

export interface WireCartItem {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  unitPrice: MoneyJSON;
  lineTotal: MoneyJSON;
  createdAt: string;
  updatedAt: string;
}

export interface WireCartTotals {
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  shipping: MoneyJSON;
  total: MoneyJSON;
}

export interface WireCart {
  id: string;
  customerId: string | null;
  currency: string;
  status: CartStatus;
  items: WireCartItem[];
  totals: WireCartTotals;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export function toWireCartItem(item: CartItem): WireCartItem {
  return {
    id: item.id,
    cartId: item.cartId,
    variantId: item.variantId,
    quantity: item.quantity,
    unitPrice: moneyToJSON(item.unitPrice),
    lineTotal: moneyToJSON(item.lineTotal),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function toWireCartTotals(totals: CartTotals): WireCartTotals {
  return {
    subtotal: moneyToJSON(totals.subtotal),
    tax: moneyToJSON(totals.tax),
    shipping: moneyToJSON(totals.shipping),
    total: moneyToJSON(totals.total),
  };
}

export function toWireCart(cart: Cart, totals: CartTotals): WireCart {
  return {
    id: cart.id,
    customerId: cart.customerId,
    currency: cart.currency,
    status: cart.status,
    items: cart.items.map((item) => toWireCartItem(item)),
    totals: toWireCartTotals(totals),
    expiresAt: cart.expiresAt.toISOString(),
    createdAt: cart.createdAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

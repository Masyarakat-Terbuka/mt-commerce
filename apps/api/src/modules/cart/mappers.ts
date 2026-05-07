/**
 * Drizzle row → cart domain type mappers.
 *
 * The two-column `(unit_price_amount, unit_price_currency)` storage shape
 * collapses into a `Money` object so the rest of the system never sees
 * a raw bigint+currency tuple. The mapping is total — every column has a
 * 1:1 destination in the domain object.
 *
 * Inverse mappers (domain → insert) live at the call sites because they
 * are simple field renames; only the read direction is non-trivial enough
 * to warrant dedicated functions.
 */
import type { Money } from "@mt-commerce/core/money";
import type { CartItemRow, CartRow } from "../../db/schema/index.js";
import type { Cart, CartItem, CartStatus } from "./types.js";

export function toCartItem(row: CartItemRow): CartItem {
  const unitPrice: Money = {
    amount: row.unitPriceAmount,
    currency: row.unitPriceCurrency,
  };
  // `lineTotal` is a derived view; we recompute it on every map so it
  // always agrees with `quantity` and `unitPrice` (no stale-cache risk).
  // BigInt * BigInt — the integer cast on `quantity` is safe because the
  // schema's CHECK guarantees `quantity > 0` and the application bounds it.
  const lineTotal: Money = {
    amount: unitPrice.amount * BigInt(row.quantity),
    currency: unitPrice.currency,
  };
  return {
    id: row.id,
    cartId: row.cartId,
    variantId: row.variantId,
    quantity: row.quantity,
    unitPrice,
    lineTotal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCart(row: CartRow, items: CartItemRow[]): Cart {
  return {
    id: row.id,
    customerId: row.customerId ?? null,
    currency: row.currency,
    // The DB column is plain text; the domain narrows to the enum union.
    status: row.status as CartStatus,
    items: items.map((item) => toCartItem(item)),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

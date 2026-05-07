/**
 * Cart domain types and Zod input schemas.
 *
 * Two layers, mirroring the catalog and customer modules:
 *
 *   1. Domain types (`Cart`, `CartItem`, `CartTotals`) — clean shapes the
 *      rest of the system consumes. Money is a `Money` value object, never
 *      a raw bigint+currency tuple. Dates are `Date` instances; the route
 *      layer converts to ISO strings on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for request
 *      shape; surfaced through the standard validation_error envelope.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES, type Money } from "@mt-commerce/core/money";

// ----------------------------------------------------------------------------
// Domain types
// ----------------------------------------------------------------------------

export type CartStatus = "active" | "abandoned" | "converted";

export interface CartItem {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  /**
   * Price-per-unit captured at the time the item was added (or last updated
   * via a re-add). Catalog price changes do NOT silently re-price the cart;
   * the shopper sees the price they added at until they re-add the item.
   */
  unitPrice: Money;
  /** Convenience: `unitPrice` * `quantity`. Same currency as `unitPrice`. */
  lineTotal: Money;
  createdAt: Date;
  updatedAt: Date;
}

export interface Cart {
  id: string;
  customerId: string | null;
  /** ISO 4217 code. Locked at first item add. */
  currency: string;
  status: CartStatus;
  items: CartItem[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartTotals {
  /** Sum of `unit_price * quantity` across line items. */
  subtotal: Money;
  /** PPN placeholder; see `service.ts#getTotals` for the contract. */
  tax: Money;
  /** Always zero at v0.1; the shipping module will plug in here. */
  shipping: Money;
  /** `subtotal + tax + shipping`. */
  total: Money;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ----------------------------------------------------------------------------
// Shared field schemas
// ----------------------------------------------------------------------------

const knownCurrencySet = new Set<string>(KNOWN_CURRENCIES);

/**
 * Same currency contract the catalog module uses: ISO 4217 shape AND a
 * member of the `KNOWN_CURRENCIES` set. A naive `^[A-Z]{3}$` check would
 * accept e.g. `"XXX"`, which then trips an `Intl.NumberFormat` runtime
 * error at the storefront. Validate at the boundary, fail fast.
 */
const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" })
  .refine((code) => knownCurrencySet.has(code), {
    message: `currency must be one of: ${[...KNOWN_CURRENCIES].sort().join(", ")}`,
  });

/**
 * Quantity bound: `1` to `1_000_000`. The lower bound matches the DB CHECK
 * (`quantity > 0`); add-cart with `0` is meaningless. The upper bound is a
 * sanity guard so a bug that smuggles a million-line input cannot wedge
 * the totals computation. Real-world carts never hit this.
 *
 * `updateItemQuantity` accepts `0` (interpreted as remove) and uses a
 * separate schema that drops the `min(1)` guard.
 */
const QUANTITY_MAX = 1_000_000;

const positiveQuantitySchema = z
  .number()
  .int({ message: "quantity must be an integer" })
  .min(1, { message: "quantity must be >= 1" })
  .max(QUANTITY_MAX, {
    message: `quantity must be <= ${QUANTITY_MAX}`,
  });

const nonNegativeQuantitySchema = z
  .number()
  .int({ message: "quantity must be an integer" })
  .min(0, { message: "quantity must be >= 0" })
  .max(QUANTITY_MAX, {
    message: `quantity must be <= ${QUANTITY_MAX}`,
  });

// ----------------------------------------------------------------------------
// Cart Zod schemas
// ----------------------------------------------------------------------------

export const cartStatusSchema = z.enum(["active", "abandoned", "converted"]);

export const createCartSchema = z.object({
  currency: currencySchema,
});
export type CreateCartInput = z.infer<typeof createCartSchema>;

export const addItemSchema = z.object({
  variantId: z.string().min(1).max(100),
  quantity: positiveQuantitySchema,
});
export type AddItemInput = z.infer<typeof addItemSchema>;

export const updateItemQuantitySchema = z.object({
  /** `0` is a legal value; the service interprets it as remove-line. */
  quantity: nonNegativeQuantitySchema,
});
export type UpdateItemQuantityInput = z.infer<typeof updateItemQuantitySchema>;

// ----------------------------------------------------------------------------
// List query (admin)
// ----------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listCartsQuerySchema = z.object({
  status: cartStatusSchema.optional(),
  customerId: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListCartsQuery = z.infer<typeof listCartsQuerySchema>;

/**
 * Shared OpenAPI wire-shape schemas for the cart routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reference the same JSON
 * shape for carts, so we register each OpenAPI component once. Runtime
 * serialization still goes through the wire helpers in `wire.ts`; these
 * schemas are the spec-side mirror.
 */
import { z } from "@hono/zod-openapi";
import { MoneyJson, paginated } from "../../../lib/openapi-shared.js";

export const CartItemWire = z
  .object({
    id: z.string(),
    cartId: z.string(),
    variantId: z.string(),
    quantity: z.number().int(),
    unitPrice: MoneyJson,
    lineTotal: MoneyJson,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CartItem");

export const CartTotalsWire = z
  .object({
    subtotal: MoneyJson,
    tax: MoneyJson,
    shipping: MoneyJson,
    total: MoneyJson,
  })
  .openapi("CartTotals");

export const CartWire = z
  .object({
    id: z.string(),
    customerId: z.string().nullable(),
    currency: z.string(),
    status: z.enum(["active", "abandoned", "converted"]),
    items: z.array(CartItemWire),
    totals: CartTotalsWire,
    expiresAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Cart");

export const PaginatedCartWire = paginated(CartWire).openapi("PaginatedCart");

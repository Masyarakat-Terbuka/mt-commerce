/**
 * Cart line item — a single (variant, quantity) entry inside a cart.
 *
 * Money capture: every line stores `unit_price_amount` and
 * `unit_price_currency` at the time the item was added. We do NOT recompute
 * prices from the live `product_variants` table on read because:
 *
 *   - Catalog price changes between "add to cart" and "view cart" should
 *     not silently re-price the basket. The shopper saw price X; they
 *     should pay price X (or be told explicitly that a refresh changed it).
 *   - The order created from this cart will copy these same captured
 *     amounts, keeping the audit trail intact across the catalog → cart →
 *     order boundary.
 *
 * The cart's `currency` (on the parent row) and every line item's
 * `unit_price_currency` MUST agree. The service enforces this on add; the
 * DB does not — adding a CHECK across tables would require a trigger and
 * the application invariant is sufficient at v0.1.
 *
 * FK semantics:
 *   - `cart_id` cascades on cart delete (line items belong to the cart).
 *   - `variant_id` is intentionally NO ACTION (no `onDelete`). A variant
 *     deletion must not silently mutate a cart — the cleanup is a deliberate
 *     decision (refund, contact customer, delete cart) that the platform
 *     surfaces to an operator rather than papering over.
 *
 * Uniqueness:
 *   - `(cart_id, variant_id)` UNIQUE. Adding the same variant twice merges
 *     into one line with summed quantity (the service performs the merge).
 *     The unique constraint is the database-side guarantee that the merge
 *     is non-negotiable: even a buggy caller cannot produce two lines for
 *     the same variant.
 */
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { carts } from "./carts.js";
import { productVariants } from "./product_variants.js";

export const cartItems = pgTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantity: integer("quantity").notNull(),
    unitPriceAmount: bigint("unit_price_amount", { mode: "bigint" }).notNull(),
    unitPriceCurrency: text("unit_price_currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    cartVariantUnique: unique("cart_items_cart_variant_unique").on(
      table.cartId,
      table.variantId,
    ),
    quantityPositive: check(
      "cart_items_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
  }),
);

export type CartItemRow = typeof cartItems.$inferSelect;
export type NewCartItemRow = typeof cartItems.$inferInsert;

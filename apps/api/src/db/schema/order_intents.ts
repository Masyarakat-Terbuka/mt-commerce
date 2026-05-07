/**
 * Order intent — placeholder consumed by the future Order module.
 *
 * Created at the moment a checkout transitions to `completed`. Carries a
 * full snapshot of every input the Order module needs to materialize an
 * order without re-resolving any cross-module state:
 *
 *   - `cart_snapshot`             — line items at the time of completion
 *                                   (variant_id, quantity, unit_price).
 *   - `totals_snapshot`           — subtotal/tax/shipping/total per
 *                                   `CartTotals`.
 *   - `shipping_address_snapshot` — full address payload (NOT just the FK)
 *                                   so that subsequent address edits cannot
 *                                   retroactively rewrite the order.
 *   - `billing_address_snapshot`  — same, optional. Null when shipping and
 *                                   billing addresses are the same row (or
 *                                   when no separate billing was selected).
 *
 * Snapshots are stored as `jsonb` because the Order module does not yet
 * exist; we cannot model proper `order_items` / `order_addresses` tables
 * without taking that scope. A follow-up migration in the Order module
 * will read these rows, write into the canonical schema, and (per the
 * follow-up plan) leave `order_intents` in place as a rebuild source.
 *
 * `checkout_id` is UNIQUE — a checkout reaches `completed` exactly once,
 * and the unique constraint is the database-side guarantee against a
 * double-fire from a buggy retry.
 */
import { jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { checkouts } from "./checkouts.js";

export const orderIntents = pgTable(
  "order_intents",
  {
    id: text("id").primaryKey(),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => checkouts.id),
    cartSnapshot: jsonb("cart_snapshot").notNull(),
    totalsSnapshot: jsonb("totals_snapshot").notNull(),
    shippingAddressSnapshot: jsonb("shipping_address_snapshot").notNull(),
    billingAddressSnapshot: jsonb("billing_address_snapshot"),
    email: text("email").notNull(),
    shippingMethodCode: text("shipping_method_code").notNull(),
    paymentMethod: text("payment_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    checkoutIdUnique: unique("order_intents_checkout_id_unique").on(
      table.checkoutId,
    ),
  }),
);

export type OrderIntentRow = typeof orderIntents.$inferSelect;
export type NewOrderIntentRow = typeof orderIntents.$inferInsert;

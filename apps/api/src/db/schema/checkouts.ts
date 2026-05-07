/**
 * Checkout — the state machine that takes an active cart, collects address +
 * shipping + payment choices, and (on completion) produces an `order_intent`.
 *
 * A checkout is single-cart and forward-only through five states:
 *
 *   pending → awaiting_shipping → awaiting_payment → completed
 *                                                  ↘ failed
 *
 * `completed` and `failed` are terminal. `awaiting_shipping` and
 * `awaiting_payment` may be revisited (revise address / shipping selection)
 * via dedicated endpoints — the service guards transitions in `state.ts`.
 *
 * Foreign keys:
 *   - `cart_id` references `carts.id` with NO `ON DELETE` clause. Deleting a
 *     cart that still has an open checkout would orphan the audit trail; the
 *     RESTRICT default surfaces the conflict to an operator.
 *   - `customer_id` mirrors the cart's customer (nullable for guest flows).
 *     Set at start time so the checkout's customer scope is stable even if
 *     the cart is later promoted.
 *   - `shipping_address_id` / `billing_address_id` reference
 *     `customer_addresses.id`; service-level validation enforces the
 *     "address belongs to this checkout's customer" invariant.
 *
 * Idempotency:
 *   - `idempotency_key` captures the key used on the COMPLETING request. The
 *     middleware (`apps/api/src/middleware/idempotency.ts`) stores the full
 *     replay envelope; this column is the durable trail tying the key to the
 *     checkout for ad-hoc inspection. UNIQUE WHEN NOT NULL — once a key
 *     completes a checkout, it cannot complete another.
 *
 * Expiration:
 *   - `expires_at` defaults to `now() + interval '1 hour'`. Checkouts are
 *     short-lived; a sweep job (out of scope for this module) will close
 *     pending/awaiting_* rows that have aged past the policy.
 */
import { index, pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { carts } from "./carts.js";
import { customers } from "./customers.js";
import { customerAddresses } from "./customer_addresses.js";

export const checkouts = pgTable(
  "checkouts",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "restrict" }),
    customerId: text("customer_id").references(() => customers.id),
    /**
     * State machine value. Stored as `text` to match the project's pattern
     * (cart status, staff role) rather than a `pgEnum`; the application
     * narrows this to a union at the boundary via `state.ts`.
     */
    state: text("state").notNull().default("pending"),
    shippingAddressId: text("shipping_address_id").references(
      () => customerAddresses.id,
    ),
    billingAddressId: text("billing_address_id").references(
      () => customerAddresses.id,
    ),
    /** Snapshot for guest checkouts; mirrors the customer's email otherwise. */
    email: text("email"),
    /** Placeholder — the future shipping module owns the canonical code set. */
    shippingMethodCode: text("shipping_method_code"),
    shippingAmount: bigint("shipping_amount", { mode: "bigint" }),
    shippingCurrency: text("shipping_currency"),
    /** Placeholder — the future payment module owns the canonical method set. */
    paymentMethod: text("payment_method"),
    cancellationReason: text("cancellation_reason"),
    /**
     * Captured for the completing transition. UNIQUE WHEN NOT NULL is
     * declared in the migration (Drizzle's schema-time `unique()` does not
     * model partial predicates).
     */
    idempotencyKey: text("idempotency_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`(now() + interval '1 hour')`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    cartIdIdx: index("checkouts_cart_id_idx").on(table.cartId),
    stateIdx: index("checkouts_state_idx").on(table.state),
    expiresAtIdx: index("checkouts_expires_at_idx").on(table.expiresAt),
  }),
);

export type CheckoutRow = typeof checkouts.$inferSelect;
export type NewCheckoutRow = typeof checkouts.$inferInsert;

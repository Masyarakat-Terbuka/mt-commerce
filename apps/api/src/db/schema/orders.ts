/**
 * Orders — the canonical financial record produced from a completed
 * `order_intent`. Per ADR-0005 (modular monolith) the orders module owns
 * these tables; per ADR-0007 every money column is `bigint` in the
 * smallest unit of `currency`.
 *
 * Modeling decisions:
 *
 *   - `customer_id` is nullable. Guest orders are first-class — the
 *     `email` column captures the buyer's contact regardless. A future
 *     migration can promote a guest order's customer link when the buyer
 *     registers, without touching financial fields.
 *
 *   - `status` lives in `text` (no `pgEnum`) for parity with cart/checkout.
 *     The application narrows the union via `state.ts`.
 *
 *   - Address is captured as a deep-copy `jsonb` snapshot, not a FK. A
 *     subsequent edit to the customer's address book must not retroactively
 *     rewrite a placed order. The shipping address is required; billing is
 *     optional (when null, the shipping address is also the billing
 *     address).
 *
 *   - Tax: we capture both the `tax_rate_code` and the `tax_rate_basis_points`
 *     resolved at order time, so a future change to the tax module's rates
 *     does not retroactively change historic orders. Both columns are
 *     nullable — guest/free orders can carry zero tax with no rate context.
 *
 *   - `order_number` is the human-readable identifier (e.g.
 *     `ORD-2026-000123`). It is allocated from a Postgres sequence so two
 *     concurrent orders never collide; the application formats the
 *     sequence value into the prefix-year-padded shape. UNIQUE because it
 *     is a customer-facing handle.
 *
 *   - Lifecycle timestamps (`paid_at`, `fulfilled_at`, `cancelled_at`,
 *     `refunded_at`) are nullable; each is set when the corresponding
 *     transition appends to `order_status_history`. They are denormalised
 *     onto the order row so admin filters ("orders paid this week") do
 *     not need to scan the history table.
 *
 * Indexing strategy:
 *   - `customer_id` for "all my orders".
 *   - `status` for admin filters.
 *   - `(customer_id, status)` composite for the "my open orders" path.
 *   - `created_at` for date-range listings (admin "today's orders").
 *   - `email` for guest-order lookup by email.
 */
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { customers } from "./customers.js";

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Human-readable, customer-facing identifier (`ORD-YYYY-NNNNNN`). */
    orderNumber: text("order_number").notNull(),
    customerId: text("customer_id").references(() => customers.id),
    /** Buyer's email at order time — captured even for registered customers. */
    email: text("email").notNull(),
    /** ISO 4217 — must match every monetary column on this row. */
    currency: text("currency").notNull(),
    /**
     * Lifecycle status. Allowed values:
     *   `pending_payment | paid | fulfilled | cancelled | refunded`.
     * Validated at the application boundary via `state.ts`.
     */
    status: text("status").notNull().default("pending_payment"),

    subtotalAmount: bigint("subtotal_amount", { mode: "bigint" }).notNull(),
    taxAmount: bigint("tax_amount", { mode: "bigint" }).notNull().default(0n),
    /** e.g. `PPN_11`. Captured at order time so historic orders are immutable. */
    taxRateCode: text("tax_rate_code"),
    /** Captured rate (basis points). 1100 = 11.00 %. */
    taxRateBasisPoints: integer("tax_rate_basis_points"),
    shippingAmount: bigint("shipping_amount", { mode: "bigint" })
      .notNull()
      .default(0n),
    /** Stable shipping method code captured at order time. */
    shippingMethodCode: text("shipping_method_code").notNull(),
    totalAmount: bigint("total_amount", { mode: "bigint" }).notNull(),

    /** Deep-copy snapshot of the shipping address (per ADR-0005). */
    shippingAddressSnapshot: jsonb("shipping_address_snapshot").notNull(),
    /** Optional billing snapshot. Null when billing == shipping. */
    billingAddressSnapshot: jsonb("billing_address_snapshot"),

    /** Free-form payment method tag (`manual_bank_transfer`, plugin codes). */
    paymentMethod: text("payment_method").notNull(),

    /** Set when status transitions to `paid`. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Set when status transitions to `fulfilled`. */
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    /** Set when status transitions to `cancelled`. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** Set when status transitions to `refunded`. */
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    /** Set alongside `cancelledAt` when the actor supplied a reason. */
    cancellationReason: text("cancellation_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderNumberUnique: unique("orders_order_number_unique").on(
      table.orderNumber,
    ),
    customerIdx: index("orders_customer_id_idx").on(table.customerId),
    statusIdx: index("orders_status_idx").on(table.status),
    customerStatusIdx: index("orders_customer_status_idx").on(
      table.customerId,
      table.status,
    ),
    createdAtIdx: index("orders_created_at_idx").on(table.createdAt),
    emailIdx: index("orders_email_idx").on(table.email),
  }),
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;

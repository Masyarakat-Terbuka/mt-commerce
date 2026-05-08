/**
 * Fulfillments — operator-facing record of a shipment's lifecycle.
 *
 * Originally introduced in 0009_shipping as a placeholder pointing at
 * `order_intent_id`. Migration 0014 swaps the FK to `order_id` now that
 * the orders module owns the canonical financial record. The cutover is
 * destructive at the column level (drop intent FK + column, add order FK
 * + column) — there is no v0.1 production data to backfill.
 *
 * Status state machine (v0.1):
 *
 *   pending ──► shipped ──► delivered
 *           ↘           ↘
 *             cancelled    cancelled
 *
 * Transitions are validated in the application layer; the column is plain
 * `text` so future state additions (e.g. `returned`) do not require a
 * schema migration.
 *
 * Lifecycle timestamps:
 *   - `tracked_at` is set when the operator marks the fulfillment as
 *     shipped (typically alongside a tracking code).
 *   - `delivered_at` is set on the `delivered` transition.
 *
 * Both are nullable because they are denormalisations of the audit trail
 * onto the parent row — admin filters ("orders shipped this week") must
 * not need to scan the audit log.
 *
 * Tracking:
 *   - `tracking_code` is a free-text courier reference. Manual fulfillment
 *     leaves it NULL until the operator pastes a code; plugin providers
 *     will populate it at create-time when they land.
 *
 * FK shapes:
 *   - `order_id` → `orders.id` ON DELETE CASCADE. Orders are not
 *     hard-deleted in v0.1; the cascade is defense-in-depth and mirrors
 *     `order_status_history`'s choice (the fulfillment is meaningless
 *     without its order).
 *   - `shipping_method_id` → `shipping_methods.id` is RESTRICT (the
 *     default). Soft-delete is the normal "retire a method" path; a hard
 *     delete that still has fulfillments must surface to an operator.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { orders } from "./orders.js";
import { shippingMethods } from "./shipping_methods.js";

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shippingMethodId: text("shipping_method_id")
      .notNull()
      .references(() => shippingMethods.id),
    /** 'pending' | 'shipped' | 'delivered' | 'cancelled' — narrowed at the application boundary. */
    status: text("status").notNull().default("pending"),
    trackingCode: text("tracking_code"),
    /** Set when status transitions to `shipped`. */
    trackedAt: timestamp("tracked_at", { withTimezone: true }),
    /** Set when status transitions to `delivered`. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderIdx: index("fulfillments_order_id_idx").on(table.orderId),
    statusIdx: index("fulfillments_status_idx").on(table.status),
  }),
);

export type FulfillmentRow = typeof fulfillments.$inferSelect;
export type NewFulfillmentRow = typeof fulfillments.$inferInsert;

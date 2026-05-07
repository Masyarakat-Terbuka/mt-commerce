/**
 * Fulfillments — minimal placeholder consumed by the future Order module.
 *
 * v0.1 ties a fulfillment to an `order_intent` because the canonical
 * `orders` table does not yet exist. When the Order module lands, the
 * `order_intent_id` FK will be replaced with `order_id` (or a parallel
 * column will be added and backfilled); this table's other columns stay
 * stable across the cutover.
 *
 * Status state machine (v0.1):
 *
 *   pending → fulfilled
 *           ↘ cancelled
 *
 * The transitions are validated in the application layer; the column is
 * `text` so future state additions do not require a schema migration.
 *
 * Tracking:
 *   - `tracking_code` is a free-text courier reference. Plugin providers
 *     will populate it at create-time; manual fulfillment leaves it NULL
 *     until the operator pastes a code in the admin.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { orderIntents } from "./order_intents.js";
import { shippingMethods } from "./shipping_methods.js";

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: text("id").primaryKey(),
    orderIntentId: text("order_intent_id")
      .notNull()
      .references(() => orderIntents.id, { onDelete: "cascade" }),
    shippingMethodId: text("shipping_method_id")
      .notNull()
      .references(() => shippingMethods.id),
    /** 'pending' | 'fulfilled' | 'cancelled' — narrowed at the application boundary. */
    status: text("status").notNull().default("pending"),
    trackingCode: text("tracking_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderIntentIdx: index("fulfillments_order_intent_idx").on(
      table.orderIntentId,
    ),
    statusIdx: index("fulfillments_status_idx").on(table.status),
  }),
);

export type FulfillmentRow = typeof fulfillments.$inferSelect;
export type NewFulfillmentRow = typeof fulfillments.$inferInsert;

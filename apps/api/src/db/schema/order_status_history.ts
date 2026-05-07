/**
 * Order status history — append-only audit trail for every order state
 * transition.
 *
 * Per ARCHITECTURE.md ("Audit and soft deletes"), financial entities keep
 * an audit log of state changes. The orders module satisfies that here:
 * every transition (initial placement, payment capture, fulfillment,
 * cancel, refund) appends one row inside the same transaction as the
 * order-row update.
 *
 * `actor_kind` separates the three legitimate origins for a transition:
 *   - `system`   — automated promotion (e.g. payment capture webhook).
 *   - `staff`    — admin operator. `actor_id` carries the auth_user_id.
 *   - `customer` — buyer-driven (initial placement, customer cancel).
 *
 * `details` carries the event-specific payload — the payment provider's
 * reference id, the fulfillment tracking code, the refund amount. Stored
 * as `jsonb` so the audit row can capture the right context for the
 * transition without proliferating columns the next transition won't use.
 *
 * FK: `order_id` cascades on order delete (defense-in-depth — orders are
 * not hard-deleted in practice).
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { orders } from "./orders.js";

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /**
     * Null for the initial placement event (no prior state). Every
     * subsequent row carries the `from_status` so the audit trail is
     * self-contained.
     */
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    /** `system | staff | customer` — narrowed at the application boundary. */
    actorKind: text("actor_kind").notNull(),
    /**
     * Auth-user-id of the actor when `actor_kind != 'system'`. Nullable to
     * cover system transitions and the (transitional) case where the auth
     * integration has not yet captured the actor.
     */
    actorId: text("actor_id"),
    /** Free-form transition context — payment refs, tracking codes, etc. */
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orderIdx: index("order_status_history_order_id_idx").on(table.orderId),
  }),
);

export type OrderStatusHistoryRow = typeof orderStatusHistory.$inferSelect;
export type NewOrderStatusHistoryRow = typeof orderStatusHistory.$inferInsert;

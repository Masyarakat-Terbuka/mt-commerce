/**
 * Checkout audit log — append-only row per state transition.
 *
 * Every successful service-level transition writes an event row. The log is
 * the platform's source of truth for "how did this checkout get to its
 * current state", surfaced to operators through the admin events endpoint.
 *
 * `from_state` is nullable so the very first event (the `startCheckout`
 * call) can record the entry into `pending` without inventing a synthetic
 * predecessor state.
 *
 * `details` is a small JSON blob carrying transition-specific context
 * (e.g. which address was chosen, which shipping method, the cancellation
 * reason). Keep it small; do NOT store PII or full address payloads here —
 * those live on the snapshot fields of `order_intents`.
 *
 * FK semantics: `checkout_id` cascades on delete because event rows are
 * meaningless without their parent checkout. (In practice we expect
 * checkouts to never be hard-deleted; the cascade is defense-in-depth.)
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { checkouts } from "./checkouts.js";

export const checkoutEvents = pgTable(
  "checkout_events",
  {
    id: text("id").primaryKey(),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => checkouts.id, { onDelete: "cascade" }),
    /** Null on the first event (entry into `pending`). */
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    checkoutIdIdx: index("checkout_events_checkout_id_idx").on(
      table.checkoutId,
    ),
  }),
);

export type CheckoutEventRow = typeof checkoutEvents.$inferSelect;
export type NewCheckoutEventRow = typeof checkoutEvents.$inferInsert;

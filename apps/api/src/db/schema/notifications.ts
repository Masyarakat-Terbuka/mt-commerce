/**
 * Notifications — small audit log of every send attempt.
 *
 * The notification module persists a row BEFORE handing off to the channel
 * adapter, then updates the same row to `sent` or `failed` once the adapter
 * settles. The audit log is the system of record for "did we send it" — the
 * adapter's own logs are best-effort and disappear at process restart.
 *
 * Field notes:
 *   - `channel` is `email` or `whatsapp`. Stored as `text` to match the
 *     project's pattern (cart status, checkout state) rather than a `pgEnum`;
 *     the application narrows this to a union at the boundary.
 *   - `kind` enumerates the templated message types (email_verification,
 *     order_confirmation, etc.). Stored as text for the same reason.
 *   - `recipient` is the email address or phone number we sent to. PII: yes,
 *     but auditing a notification log without the addressee makes the table
 *     useless for "did this customer get the email?" queries.
 *   - `subject` is nullable — channels like WhatsApp have no subject; email
 *     always carries one.
 *   - `payload` is the template variables (orderId, totals, etc.). Do NOT
 *     store the rendered body here — bodies are large and re-derivable from
 *     the template + payload.
 *   - `status` is `pending` while the row is in flight, `sent` after success,
 *     `failed` with `error_message` set after a thrown adapter call.
 *   - `event_id` is set when the row was produced by an event-bus listener
 *     (order.placed, payment.captured, fulfillment.shipped). The id is a
 *     deterministic string the listener derives from the event payload — see
 *     `apps/api/src/modules/notification/service.ts` for the format. Null
 *     for non-event sends (`email_verification`, `password_reset`). The
 *     partial unique index below uses this column to reject a duplicate
 *     `(event_id, kind, channel)` insert so a re-delivered event cannot
 *     spawn a second send. The partial-on-not-null shape leaves the
 *     existing non-event sends untouched (they can still write multiple
 *     rows for the same recipient — verification mail can be re-sent).
 *
 * Indexes:
 *   - `created_at` — admin "recent notifications" query and TTL sweeps.
 *   - `(channel, status)` — operator dashboards filter by these two together
 *     ("how many emails are stuck pending right now").
 *   - `(event_id, kind, channel)` UNIQUE WHERE event_id IS NOT NULL — DB-
 *     enforced idempotency for event-driven sends. The application catches
 *     the 23505 raised on duplicate insert and returns the existing row.
 */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    /**
     * Optional deterministic key for event-driven sends. Null for non-event
     * sends. The partial unique index `notifications_event_kind_channel_uniq`
     * enforces "at most one row per (event_id, kind, channel)" so a duplicate
     * event delivery cannot produce a second send. See the column comment
     * above.
     */
    eventId: text("event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdAtIdx: index("notifications_created_at_idx").on(table.createdAt),
    channelStatusIdx: index("notifications_channel_status_idx").on(
      table.channel,
      table.status,
    ),
    /**
     * Idempotency guard. Drizzle's `uniqueIndex` does not surface a partial
     * `WHERE` clause in the generated DDL on every dialect, so the actual
     * partial predicate lives in the hand-written migration
     * (`drizzle/migrations/0015_notifications_event_id.sql`). The schema-side
     * index here is plain unique — it is harmless even if Drizzle ever
     * regenerates it because the migration is the source of truth for the
     * `WHERE event_id IS NOT NULL` clause.
     */
    eventKindChannelUniq: uniqueIndex(
      "notifications_event_kind_channel_uniq",
    ).on(table.eventId, table.kind, table.channel),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

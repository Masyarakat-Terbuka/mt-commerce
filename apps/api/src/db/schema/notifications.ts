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
 *
 * Indexes:
 *   - `created_at` — admin "recent notifications" query and TTL sweeps.
 *   - `(channel, status)` — operator dashboards filter by these two together
 *     ("how many emails are stuck pending right now").
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

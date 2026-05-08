-- Notification idempotency: event_id column + partial unique index.
--
-- Hand-written rather than drizzle-kit-generated so the partial index's
-- `WHERE event_id IS NOT NULL` clause stays explicit (drizzle-kit emits
-- a plain unique index without the predicate).
--
-- Why a partial index, not a full unique constraint:
--
--   * Non-event sends (`email_verification`, `password_reset`) write rows
--     with `event_id = NULL`. Those callers MUST be free to send the same
--     kind to the same recipient repeatedly (a customer can request a
--     second verification email). A full unique on `(event_id, kind,
--     channel)` would pass anyway because two NULLs do not collide in
--     PostgreSQL — but the partial form makes the intent explicit and
--     spares the index pages for the rows that don't need it.
--
--   * Event-driven sends carry a deterministic `event_id` derived from the
--     event payload (e.g. `event:order.placed:ord_123`). The unique index
--     guarantees: if the same event is delivered twice (event-bus glitch,
--     webhook re-fire upstream), the second insert raises 23505 and the
--     service treats it as "already sent" — returns the existing row
--     without re-dispatching to the channel.
--
--   * The triple `(event_id, kind, channel)` is the right grain. The same
--     event MAY produce two rows of different kinds (a single
--     `order.placed` could fan out to `order_confirmation` email + a
--     future `order_confirmation_sms` row) or different channels (email +
--     WhatsApp). The triple is what we want exactly-once on.
--
-- Re-running the migration is a no-op (column add and index create are
-- idempotent guards).

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "event_id" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_kind_channel_uniq"
  ON "notifications" ("event_id", "kind", "channel")
  WHERE "event_id" IS NOT NULL;

-- Notification module: notifications.
--
-- Hand-written rather than drizzle-kit-generated to keep the index list
-- explicit and auditable alongside the other v0.1 migrations.
--
-- Notes:
--   * `channel` and `kind` are `text`, not `pgEnum`, matching the project's
--     existing pattern (cart.status, checkouts.state). The application
--     narrows the union at the boundary.
--   * `payload` defaults to `'{}'::jsonb` so a row written without explicit
--     template variables stays well-formed.
--   * `status` defaults to `'pending'` so the service can INSERT first and
--     UPDATE-to-sent/failed after the adapter settles. The audit row exists
--     even when the channel itself crashes the process mid-send.
--   * Indexes:
--     - `notifications_created_at_idx` supports admin recent-list and a
--       future TTL sweep job.
--     - `notifications_channel_status_idx` supports operator dashboards
--       grouping pending-by-channel.

CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_channel_status_idx" ON "notifications" ("channel", "status");

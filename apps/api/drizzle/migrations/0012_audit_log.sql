-- Generic audit log: append-only trail of state changes across modules.
--
-- Hand-written rather than drizzle-kit-generated to keep the index list
-- explicit and auditable alongside the other v0.1 migrations.
--
-- Notes:
--   * `entity_kind`, `action`, and `actor_kind` are `text`, not `pgEnum`,
--     matching the project's existing pattern (orders.status, cart.status).
--     The application narrows each to a typed union at the boundary.
--   * `actor_id` is intentionally NOT a FK to any auth table — staff
--     accounts can be deleted, but the audit trail must outlive them.
--   * `details` defaults to `'{}'::jsonb` so a row written without explicit
--     payload stays well-formed.
--   * The composite `(entity_kind, entity_id, created_at DESC)` index serves
--     the hot path: "show the audit history for entity X, newest first."
--     A single index covers the equality predicates on the leading columns
--     and the reverse-time order-by.

CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" ("entity_kind", "entity_id", "created_at");

-- Fulfillments cutover: order_intent_id → order_id, plus lifecycle timestamps.
--
-- Hand-written rather than drizzle-kit-generated so the FK-shape change and
-- the new lifecycle columns stay reviewable in one place.
--
-- Notes:
--   * v0.1 has no production fulfillments yet — the original 0009_shipping
--     migration introduced the table as a placeholder pointing at
--     `order_intent_id`. Now that the orders module owns the canonical
--     financial record, the FK swaps to `order_id` and the column rename is
--     destructive (no backfill). Re-running this migration is a no-op
--     because each statement is idempotent.
--
--   * `order_id` references `orders.id` ON DELETE CASCADE. Orders are not
--     hard-deleted in v0.1; the cascade is defense-in-depth and matches
--     `order_status_history` — a fulfillment is meaningless without its
--     order, and we'd rather not orphan rows if a manual cleanup ever runs.
--
--   * `shipping_method_id` keeps its existing RESTRICT FK from 0009.
--
--   * `tracked_at` / `delivered_at` denormalise the audit trail onto the
--     parent row so admin filters ("orders shipped this week") do not need
--     to scan `audit_log`. Both nullable; the application sets each on the
--     corresponding lifecycle transition.
--
--   * The status text column is unchanged. The application now narrows it
--     to the wider set `pending | shipped | delivered | cancelled` (v0.1
--     state machine). Keeping the column as plain `text` means future
--     additions (e.g. `returned`) do not require a schema migration.

-- 1. Drop the old order_intent_id index and FK before dropping the column.
DROP INDEX IF EXISTS "fulfillments_order_intent_idx";
--> statement-breakpoint
ALTER TABLE "fulfillments"
  DROP CONSTRAINT IF EXISTS "fulfillments_order_intent_id_order_intents_id_fk";
--> statement-breakpoint
ALTER TABLE "fulfillments" DROP COLUMN IF EXISTS "order_intent_id";
--> statement-breakpoint

-- 2. Add order_id with FK to orders. Adding NOT NULL on an empty table is
--    safe; the empty-table guarantee is documented above.
ALTER TABLE "fulfillments" ADD COLUMN "order_id" text NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fulfillments"
    ADD CONSTRAINT "fulfillments_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_order_id_idx"
  ON "fulfillments" ("order_id");
--> statement-breakpoint

-- 3. Lifecycle timestamps. Both nullable.
ALTER TABLE "fulfillments"
  ADD COLUMN IF NOT EXISTS "tracked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fulfillments"
  ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;

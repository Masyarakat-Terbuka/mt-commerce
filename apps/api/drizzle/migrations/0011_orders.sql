-- Orders module: orders + order_items + order_status_history.
--
-- Hand-written rather than drizzle-kit-generated to keep:
--   * the `order_number_seq` Postgres sequence next to the `orders` table
--     it backs,
--   * the FK shape (cascade vs no action) on `order_items.variant_id`
--     reviewable here — we deliberately do NOT cascade from variant
--     delete because variant lifecycle is decoupled from orders,
--   * the `quantity > 0` CHECK on `order_items` explicit.
--
-- Notes:
--   * `orders.order_number` is allocated from `order_number_seq` and
--     formatted at the application boundary as `ORD-YYYY-NNNNNN`. The
--     UNIQUE constraint is the database-side guarantee against a buggy
--     formatter or a manual insert from psql.
--   * `orders.customer_id` is NULLABLE — guest orders are first-class.
--     ON DELETE NO ACTION (default) is intentional: deleting a customer
--     who still has orders surfaces the conflict to an operator instead
--     of silently dropping the financial trail.
--   * `order_items.variant_id` is ON DELETE NO ACTION — variant lifecycle
--     is decoupled. The captured `sku` and `title_translations` keep the
--     line renderable even if the variant row is later deleted.
--   * `order_status_history.order_id` cascades — defense in depth (orders
--     are not hard-deleted in v0.1).

CREATE SEQUENCE IF NOT EXISTS "order_number_seq" START 100000;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" text,
	"email" text NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"subtotal_amount" bigint NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"tax_rate_code" text,
	"tax_rate_basis_points" integer,
	"shipping_amount" bigint DEFAULT 0 NOT NULL,
	"shipping_method_code" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"shipping_address_snapshot" jsonb NOT NULL,
	"billing_address_snapshot" jsonb,
	"payment_method" text NOT NULL,
	"paid_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"sku" text NOT NULL,
	"title_translations" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"line_subtotal_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Lookup paths.
--   * `orders_customer_id_idx`        — "all my orders".
--   * `orders_status_idx`             — admin filter by status.
--   * `orders_customer_status_idx`    — "my open orders" composite.
--   * `orders_created_at_idx`         — admin date-range listings.
--   * `orders_email_idx`              — guest-order lookup by email.
--   * `order_items_order_id_idx`      — every line read scopes by order.
--   * `order_items_variant_id_idx`    — admin "what orders contained X".
--   * `order_status_history_order_id_idx` — audit trail per order.
CREATE INDEX IF NOT EXISTS "orders_customer_id_idx" ON "orders" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_customer_status_idx" ON "orders" ("customer_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_email_idx" ON "orders" ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_variant_id_idx" ON "order_items" ("variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_status_history_order_id_idx" ON "order_status_history" ("order_id");

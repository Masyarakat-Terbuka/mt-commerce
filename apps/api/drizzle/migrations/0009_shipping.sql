-- Shipping module: shipping_methods + fulfillments.
--
-- Hand-written rather than drizzle-kit-generated so the cross-column CHECK
-- on `shipping_methods` stays explicit and readable, and so the FK shape on
-- `fulfillments` (cascade vs restrict) is reviewable here.
--
-- Notes:
--   * `shipping_methods.provider_kind` is `text` rather than a `pgEnum`
--     because future plugin kinds extend the set. The application narrows
--     the union (`'manual' | 'plugin'`) at the boundary.
--   * The CHECK constraint encodes the v0.1 invariant:
--     "manual ⇒ both flat_rate_amount & flat_rate_currency NOT NULL,
--      amount >= 0; plugin ⇒ both NULL". Plugin-side rate resolution is the
--     plugin's responsibility, not a stored value.
--   * `fulfillments.order_intent_id` cascades — a deleted order_intent has
--     no fulfillments to track. The schema notes that `order_intents` are
--     not hard-deleted in v0.1; the cascade is defense-in-depth.
--   * `fulfillments.shipping_method_id` is RESTRICT — deleting a shipping
--     method that still has fulfillments would orphan the operator's
--     audit trail. Soft-delete (`shipping_methods.deleted_at`) is the
--     normal "retire a method" path.

CREATE TABLE IF NOT EXISTS "shipping_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"provider_kind" text NOT NULL,
	"flat_rate_amount" bigint,
	"flat_rate_currency" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shipping_methods_code_unique" UNIQUE("code"),
	CONSTRAINT "shipping_methods_manual_has_flat_rate" CHECK (
		(
			"provider_kind" = 'manual'
			AND "flat_rate_amount" IS NOT NULL
			AND "flat_rate_currency" IS NOT NULL
			AND "flat_rate_amount" >= 0
		)
		OR
		(
			"provider_kind" = 'plugin'
			AND "flat_rate_amount" IS NULL
			AND "flat_rate_currency" IS NULL
		)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipping_methods_active_idx" ON "shipping_methods" ("is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fulfillments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_intent_id" text NOT NULL,
	"shipping_method_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tracking_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_shipping_method_id_shipping_methods_id_fk" FOREIGN KEY ("shipping_method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_order_intent_idx" ON "fulfillments" ("order_intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_status_idx" ON "fulfillments" ("status");

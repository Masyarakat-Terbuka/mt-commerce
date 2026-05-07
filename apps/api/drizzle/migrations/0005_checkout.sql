-- Checkout module: checkouts + checkout_events + order_intents +
-- idempotency_keys.
--
-- Hand-written rather than drizzle-kit-generated to keep:
--   * the partial UNIQUE on `checkouts(idempotency_key) WHERE idempotency_key
--     IS NOT NULL` explicit (drizzle-kit doesn't natively express partial
--     unique indexes),
--   * the `expires_at` default expression `now() + interval '1 hour'`,
--   * and the `RESTRICT` semantics on `checkouts.cart_id` readable.
--
-- Notes:
--   * `checkouts.cart_id` deliberately uses RESTRICT (`ON DELETE NO ACTION`).
--     Deleting a cart that still has an open checkout would orphan the
--     audit trail — the conflict surfaces to an operator instead.
--   * `checkout_events.checkout_id` cascades — events are meaningless
--     without their parent checkout. Defense-in-depth (we do not expect
--     checkouts to be hard-deleted).
--   * `order_intents.checkout_id` is UNIQUE; a checkout reaches `completed`
--     exactly once.
--   * The `idempotency_keys` table is part of the same release because the
--     completing transition is the canonical idempotent endpoint and the
--     middleware ships in this PR.

CREATE TABLE IF NOT EXISTS "checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"customer_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"shipping_address_id" text,
	"billing_address_id" text,
	"email" text,
	"shipping_method_code" text,
	"shipping_amount" bigint,
	"shipping_currency" text,
	"payment_method" text,
	"cancellation_reason" text,
	"idempotency_key" text,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '1 hour') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkout_events" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_id" text NOT NULL,
	"cart_snapshot" jsonb NOT NULL,
	"totals_snapshot" jsonb NOT NULL,
	"shipping_address_snapshot" jsonb NOT NULL,
	"billing_address_snapshot" jsonb,
	"email" text NOT NULL,
	"shipping_method_code" text NOT NULL,
	"payment_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_intents_checkout_id_unique" UNIQUE("checkout_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_shipping_address_id_customer_addresses_id_fk" FOREIGN KEY ("shipping_address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_billing_address_id_customer_addresses_id_fk" FOREIGN KEY ("billing_address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "checkout_events" ADD CONSTRAINT "checkout_events_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Lookup paths.
--   * `checkouts_cart_id_idx` — admin/debug "checkout for cart X" lookup.
--   * `checkouts_state_idx`   — admin filter "show me all awaiting_payment".
--   * `checkouts_expires_at_idx` — sweep job for expired checkouts.
--   * `checkouts_idempotency_key_unique_idx` — partial unique on the
--     idempotency_key column. Once a key completes a checkout, no other
--     checkout may reuse it.
--   * `checkout_events_checkout_id_idx` — every read of the audit trail
--     scopes by checkout.
--   * `idempotency_keys_created_at_idx` — supports the future TTL job.
CREATE INDEX IF NOT EXISTS "checkouts_cart_id_idx" ON "checkouts" ("cart_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkouts_state_idx" ON "checkouts" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkouts_expires_at_idx" ON "checkouts" ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checkouts_idempotency_key_unique_idx" ON "checkouts" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_events_checkout_id_idx" ON "checkout_events" ("checkout_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx" ON "idempotency_keys" ("created_at");

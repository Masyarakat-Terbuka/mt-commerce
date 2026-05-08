-- Payments module: payments + payment_attempts.
--
-- Hand-written rather than drizzle-kit-generated to keep:
--   * the FK shapes (cascade vs no action) reviewable here — both tables
--     cascade-delete from their parent (orders → payments, payments →
--     payment_attempts) because deleting an order is itself a guarded
--     operation and a stranded payment row would be worse than a coherent
--     cleanup,
--   * the partial-style "payments_provider_ref_idx" composite indexed
--     against (provider, provider_ref) explicit alongside its read path
--     (the webhook dispatcher),
--   * the unique on `idempotency_key` documented as the dedupe handle for
--     the business-level `initiate` call (NOT the HTTP-layer
--     `idempotency_keys` table — those serve different scopes).
--
-- Notes:
--   * `provider` is `text`, not a `pgEnum`, so plugins can add new codes
--     (`midtrans`, `xendit`, ...) without a migration. The application
--     narrows via the runtime registry.
--   * `provider_ref` is NULLABLE — we write the payments row before
--     calling the provider so an idempotent retry on the same
--     `idempotency_key` returns the existing row even if the first
--     provider call failed. Once the adapter responds we patch this column.
--   * `payment_attempts` is append-only — every `initiate` / `capture` /
--     `refund` / `webhook` round-trip writes a row. JSON payloads are
--     stored verbatim so a future incident review can replay against a
--     sandbox.
--   * `request_payload` defaults to `'{}'::jsonb` so a row written without
--     an explicit payload stays well-formed.

CREATE TABLE IF NOT EXISTS "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Lookup paths.
--   * `payments_order_id_idx`           — "show me the payment for this order".
--   * `payments_provider_ref_idx`       — webhook dispatch: resolve a
--                                         provider event to a payment row
--                                         via (provider, provider_ref).
--   * `payment_attempts_payment_created_idx` — audit-trail per payment,
--                                         newest first.
CREATE INDEX IF NOT EXISTS "payments_order_id_idx" ON "payments" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_provider_ref_idx" ON "payments" ("provider", "provider_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_attempts_payment_created_idx" ON "payment_attempts" ("payment_id", "created_at");

-- Cart module: carts and cart_items.
--
-- Hand-written rather than drizzle-kit-generated to keep:
--   * the partial unique-style index on `(customer_id) WHERE status='active'`
--     explicit (drizzle-kit doesn't natively express partial indexes),
--   * the `expires_at` default expression `now() + interval '30 days'`,
--   * and the cross-row `(cart_id, variant_id)` UNIQUE constraint readable.
--
-- Notes:
--   * `cart_items.variant_id` deliberately has NO `ON DELETE` clause. A
--     variant deletion must NOT silently mutate a customer's cart; the
--     RESTRICT default surfaces the conflict to an operator instead.
--   * `cart_items.cart_id` cascades — line items belong to the cart.
--   * `quantity` is `integer` with a CHECK > 0. The service merges duplicate
--     variant adds into a single line; the unique index `(cart_id, variant_id)`
--     is the database-side guarantee.

CREATE TABLE IF NOT EXISTS "carts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT (now() + interval '30 days') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cart_items" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_cart_variant_unique" UNIQUE("cart_id","variant_id"),
	CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Lookup paths.
--   * `customers_active_cart_idx` — partial index that supports
--     `getActiveCartForCustomer`. The storefront hits this on every
--     authenticated pageview, so the partial keeps the index small (most
--     carts end up converted/abandoned and are excluded).
--   * `carts_customer_id_idx` — broader index for admin "all carts for
--     customer X" listings, regardless of status.
--   * `carts_expires_at_idx` — supports the future cleanup job's
--     "find me carts that have aged past the policy" range scan.
--   * `cart_items_cart_id_idx` — every cart read joins items by cart_id.
CREATE INDEX IF NOT EXISTS "carts_customer_id_idx" ON "carts" ("customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_active_customer_idx" ON "carts" ("customer_id") WHERE "status" = 'active' AND "customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "carts_expires_at_idx" ON "carts" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_items_cart_id_idx" ON "cart_items" ("cart_id");

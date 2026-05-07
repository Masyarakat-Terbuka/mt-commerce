-- Customer module: customer profiles, addresses, and the four-level
-- Indonesian admin region tree (provinsi → kota_kabupaten → kecamatan →
-- kelurahan). Hand-written rather than drizzle-kit-generated to keep the
-- partial unique indexes (default-shipping/billing) and the address-kind
-- enum explicit.
--
-- Notes:
--   * `customers.auth_user_id` carries NO FK constraint in this migration.
--     Track A (auth) and Track B (customer) ship in parallel; a follow-up
--     migration will add the FK once both modules are in. See
--     `apps/api/src/db/schema/customers.ts` for the rationale.
--   * Region PKs are BPS codes (e.g. provinsi "31" = DKI Jakarta) so address
--     rows survive a future bulk import of the official BPS dataset. There
--     is no separate `code` column — `id` IS the code; an earlier draft kept
--     both, but they always carried the same value and the duplication
--     created a class of "compared the wrong field" bugs without buying
--     anything.

DO $$ BEGIN
 CREATE TYPE "public"."address_kind" AS ENUM('shipping', 'billing');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provinsi" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kota_kabupaten" (
	"id" text PRIMARY KEY NOT NULL,
	"provinsi_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kecamatan" (
	"id" text PRIMARY KEY NOT NULL,
	"kota_kabupaten_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kelurahan" (
	"id" text PRIMARY KEY NOT NULL,
	"kecamatan_id" text NOT NULL,
	"name" text NOT NULL,
	"postal_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_user_id" text,
	"email" text NOT NULL,
	"display_name" text,
	"phone" text,
	"tax_identifier" text,
	"company_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"kind" "address_kind" NOT NULL,
	"is_default_shipping" boolean DEFAULT false NOT NULL,
	"is_default_billing" boolean DEFAULT false NOT NULL,
	"recipient_name" text NOT NULL,
	"phone" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"provinsi_id" text NOT NULL,
	"kota_kabupaten_id" text NOT NULL,
	"kecamatan_id" text NOT NULL,
	"kelurahan_id" text,
	"postal_code" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
-- Region hierarchy FKs cascade downward: deleting a provinsi removes its
-- kota/kabupaten and everything beneath. Region tables are reference data
-- managed by the platform (BPS imports), not user content; cascade is the
-- correct semantics here.
DO $$ BEGIN
 ALTER TABLE "kota_kabupaten" ADD CONSTRAINT "kota_kabupaten_provinsi_id_provinsi_id_fk" FOREIGN KEY ("provinsi_id") REFERENCES "public"."provinsi"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kecamatan" ADD CONSTRAINT "kecamatan_kota_kabupaten_id_kota_kabupaten_id_fk" FOREIGN KEY ("kota_kabupaten_id") REFERENCES "public"."kota_kabupaten"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "kelurahan" ADD CONSTRAINT "kelurahan_kecamatan_id_kecamatan_id_fk" FOREIGN KEY ("kecamatan_id") REFERENCES "public"."kecamatan"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Customer addresses cascade with the parent customer. Region FKs use the
-- default RESTRICT (no ON DELETE clause) — a region row that any address
-- references must not be silently removed; an explicit migration would have
-- to handle the affected addresses first.
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_provinsi_id_provinsi_id_fk" FOREIGN KEY ("provinsi_id") REFERENCES "public"."provinsi"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_kota_kabupaten_id_kota_kabupaten_id_fk" FOREIGN KEY ("kota_kabupaten_id") REFERENCES "public"."kota_kabupaten"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_kecamatan_id_kecamatan_id_fk" FOREIGN KEY ("kecamatan_id") REFERENCES "public"."kecamatan"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_kelurahan_id_kelurahan_id_fk" FOREIGN KEY ("kelurahan_id") REFERENCES "public"."kelurahan"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Lookup paths.
CREATE INDEX IF NOT EXISTS "customers_auth_user_id_idx" ON "customers" ("auth_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kota_kabupaten_provinsi_id_idx" ON "kota_kabupaten" ("provinsi_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kecamatan_kota_kabupaten_id_idx" ON "kecamatan" ("kota_kabupaten_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kelurahan_kecamatan_id_idx" ON "kelurahan" ("kecamatan_id");
--> statement-breakpoint
-- Postal-code lookup is the storefront's autofill hot path; multiple
-- kelurahans can share a postal code (rare but real), so the index is
-- non-unique.
CREATE INDEX IF NOT EXISTS "kelurahan_postal_code_idx" ON "kelurahan" ("postal_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_addresses_customer_id_idx" ON "customer_addresses" ("customer_id");
--> statement-breakpoint
-- "At most one default per kind per customer" — partial unique indexes that
-- only kick in for the rows actually flagged as default and not soft-deleted.
-- Standard `UNIQUE` would require treating non-default rows as duplicates;
-- partials let an address opt in. The `deleted_at IS NULL` guard means a
-- soft-deleted prior default does not block setting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_addresses_default_shipping_unique" ON "customer_addresses" ("customer_id") WHERE "is_default_shipping" AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_addresses_default_billing_unique" ON "customer_addresses" ("customer_id") WHERE "is_default_billing" AND "deleted_at" IS NULL;

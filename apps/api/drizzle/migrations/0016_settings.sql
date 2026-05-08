-- Settings module: store_settings (singleton).
--
-- Hand-written rather than drizzle-kit-generated so:
--   * The CHECK constraint pinning `id = 'singleton'` stays explicit.
--     drizzle-kit does not model CHECK constraints.
--   * The CHECK pinning `default_locale IN ('id', 'en')` stays explicit.
--   * The FK to `tax_rates(id)` carries the `ON DELETE SET NULL` rule so
--     hard-deleting a referenced rate does not orphan the singleton row.
--
-- Why singleton and not a KV table:
--   * The wire shape is fixed and small; we want one typed row, not a
--     `Record<string, unknown>` reconstructed from a key/value table.
--   * All callers read the entire blob (`getSettings()`); per-key reads
--     would just rebuild the blob anyway.
--   * The CHECK + PRIMARY KEY makes "exactly one row" a database fact, not
--     a service convention. A second insert with `id = 'singleton'` raises
--     23505; a wrong `id` raises a check violation.
--
-- Region columns are plain `text` without FKs — same shape as
-- `customer_addresses` keeps them. The settings service does not validate
-- the BPS hierarchy at v0.1; the admin UI sources the dropdowns from the
-- region tables, so the values that arrive here are already canonical.
-- A future migration can add per-level FKs once we are confident no caller
-- has stale data.

CREATE TABLE IF NOT EXISTS "store_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"store_name" text DEFAULT 'mt-commerce' NOT NULL,
	"default_currency" text DEFAULT 'IDR' NOT NULL,
	"default_locale" text DEFAULT 'id' NOT NULL,
	"default_tax_rate_id" text,
	"shipping_origin_provinsi_id" text,
	"shipping_origin_kota_kabupaten_id" text,
	"shipping_origin_kecamatan_id" text,
	"shipping_origin_kelurahan_id" text,
	"shipping_origin_postal_code" text,
	"shipping_origin_address_line1" text,
	"shipping_origin_phone" text,
	"notification_email_enabled" boolean DEFAULT true NOT NULL,
	"notification_whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_settings_singleton_id_chk" CHECK ("id" = 'singleton'),
	CONSTRAINT "store_settings_locale_chk" CHECK ("default_locale" IN ('id', 'en')),
	CONSTRAINT "store_settings_default_tax_rate_id_fk" FOREIGN KEY ("default_tax_rate_id")
		REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

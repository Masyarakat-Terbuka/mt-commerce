/**
 * Store settings — a singleton row keyed by `id = 'singleton'`.
 *
 * Storage choice: a single typed row beats a generic key/value table for v0.1
 * because:
 *   - The wire shape is fixed and small; we want types end-to-end without a
 *     `Record<string, unknown>` escape hatch.
 *   - All callers read the entire blob (`getSettings()`); per-key reads
 *     would just rebuild that blob anyway.
 *   - The CHECK constraint `id = 'singleton'` plus the PRIMARY KEY makes the
 *     "exactly one row" invariant a database-level fact, not an application
 *     convention. A second insert raises 23505; a wrong id raises a check
 *     violation.
 *
 * Drizzle does not model CHECK constraints directly, so the migration
 * `0016_settings.sql` is hand-written; this schema file mirrors the column
 * shape so the row type compiles end-to-end.
 *
 * Foreign keys:
 *   - `default_tax_rate_id` → `tax_rates.id` (ON DELETE SET NULL). A merchant
 *     archiving their default rate gets a `null` here rather than a dangling
 *     reference. The four region FKs are intentionally NOT modelled here —
 *     they live in the migration as `text` columns without referential
 *     integrity, mirroring how `customer_addresses` keeps the region ids as
 *     loose text (the customer service validates the hierarchy at write).
 */
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const storeSettings = pgTable("store_settings", {
  /**
   * Sentinel id: always `'singleton'`. The CHECK constraint in the
   * migration enforces this; the PRIMARY KEY enforces the singleton.
   */
  id: text("id").primaryKey().default("singleton").notNull(),

  // Toko / Store
  storeName: text("store_name").notNull().default("mt-commerce"),
  defaultCurrency: text("default_currency").notNull().default("IDR"),
  /** "id" or "en". Application-level enum; DB CHECK in the migration. */
  defaultLocale: text("default_locale").notNull().default("id"),

  // Pajak / Tax
  /**
   * Optional default tax-rate FK. NULL when the merchant has not picked one
   * (cart totals fall back to env-driven config). ON DELETE SET NULL keeps
   * the singleton row alive when the referenced rate is hard-deleted.
   */
  defaultTaxRateId: text("default_tax_rate_id"),

  // Pengiriman / Shipping origin (full Indonesian address)
  shippingOriginProvinsiId: text("shipping_origin_provinsi_id"),
  shippingOriginKotaKabupatenId: text("shipping_origin_kota_kabupaten_id"),
  shippingOriginKecamatanId: text("shipping_origin_kecamatan_id"),
  shippingOriginKelurahanId: text("shipping_origin_kelurahan_id"),
  shippingOriginPostalCode: text("shipping_origin_postal_code"),
  shippingOriginAddressLine1: text("shipping_origin_address_line1"),
  shippingOriginPhone: text("shipping_origin_phone"),

  // Notifikasi / Notifications
  notificationEmailEnabled: boolean("notification_email_enabled")
    .notNull()
    .default(true),
  notificationWhatsappEnabled: boolean("notification_whatsapp_enabled")
    .notNull()
    .default(false),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type StoreSettingsRow = typeof storeSettings.$inferSelect;
export type NewStoreSettingsRow = typeof storeSettings.$inferInsert;

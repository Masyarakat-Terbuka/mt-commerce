/**
 * Settings module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the rest of the modules:
 *
 *   1. Domain types (`StoreSettings`) — clean shape consumed by callers.
 *      Dates are `Date`; the route layer converts to ISO strings on the way
 *      out. Resolved region NAMES are surfaced as siblings of the BPS id
 *      fields so the admin UI does not have to do a second round-trip per
 *      dropdown level (mirrors the customer-addresses pattern).
 *
 *   2. Zod schema for the PATCH body. Source of truth for request shape;
 *      surfaced through the standard validation_error envelope.
 *
 * Why a partial-update schema (every key optional with a `.refine` for
 * "at least one field"): clients should not have to round-trip the entire
 * settings blob to flip a single boolean. The shape mirrors the row but
 * collapses `undefined` (unset, leave alone) and `null` (clear) cleanly.
 */
import { z } from "zod";
import { KNOWN_CURRENCIES } from "@mt-commerce/core/money";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type SupportedLocale = "id" | "en";

export interface StoreSettings {
  storeName: string;
  defaultCurrency: string;
  defaultLocale: SupportedLocale;

  /** FK to `tax_rates.id`. Null when no default has been picked. */
  defaultTaxRateId: string | null;

  // Shipping origin (full Indonesian address)
  shippingOriginProvinsiId: string | null;
  shippingOriginKotaKabupatenId: string | null;
  shippingOriginKecamatanId: string | null;
  shippingOriginKelurahanId: string | null;
  shippingOriginPostalCode: string | null;
  shippingOriginAddressLine1: string | null;
  shippingOriginPhone: string | null;

  /**
   * Resolved region names — surfaced as siblings of the id fields so the
   * UI can render `name ?? id` without a second lookup. `undefined` when
   * the corresponding id is `null` OR when the joined region row is
   * missing (e.g. a stale id surviving a region prune).
   */
  shippingOriginProvinsiName?: string;
  shippingOriginKotaKabupatenName?: string;
  shippingOriginKecamatanName?: string;
  shippingOriginKelurahanName?: string;

  notificationEmailEnabled: boolean;
  notificationWhatsappEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const knownCurrencySet = new Set<string>(KNOWN_CURRENCIES);

const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "currency must be a 3-letter ISO 4217 code" })
  .refine((code) => knownCurrencySet.has(code), {
    message: `currency must be one of: ${[...KNOWN_CURRENCIES].sort().join(", ")}`,
  });

const localeSchema = z.enum(["id", "en"]);

/**
 * E.164-ish phone — copied from customer module. Optional `+`, then a 1-9
 * country-code start, then 1-14 digits. The leading `+` is not required so
 * national format (`0812...`) also passes.
 */
const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, {
    message: "phone must be a valid E.164 number (e.g. +6281234567890)",
  });

const postalCodeSchema = z.string().regex(/^\d{5}$/, {
  message: "postalCode must be a 5-digit numeric string",
});

const regionIdSchema = z.string().min(1).max(32);
const idSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// Patch schema
// ---------------------------------------------------------------------------

/**
 * Partial-update body. Keys are optional (caller flips one or many at a
 * time); nullable values let the caller clear an optional field. The
 * `.refine` enforces at least one field so an empty PATCH is rejected at
 * the boundary.
 */
export const updateSettingsSchema = z
  .object({
    storeName: z.string().min(1).max(200).optional(),
    defaultCurrency: currencySchema.optional(),
    defaultLocale: localeSchema.optional(),

    defaultTaxRateId: idSchema.nullable().optional(),

    shippingOriginProvinsiId: regionIdSchema.nullable().optional(),
    shippingOriginKotaKabupatenId: regionIdSchema.nullable().optional(),
    shippingOriginKecamatanId: regionIdSchema.nullable().optional(),
    shippingOriginKelurahanId: regionIdSchema.nullable().optional(),
    shippingOriginPostalCode: postalCodeSchema.nullable().optional(),
    shippingOriginAddressLine1: z.string().min(1).max(500).nullable().optional(),
    shippingOriginPhone: phoneSchema.nullable().optional(),

    notificationEmailEnabled: z.boolean().optional(),
    notificationWhatsappEnabled: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

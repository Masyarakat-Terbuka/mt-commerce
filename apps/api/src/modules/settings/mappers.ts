/**
 * Drizzle row → settings domain type mapper.
 *
 * Mirrors the customer-addresses pattern: the repository's read paths LEFT
 * JOIN the four region tables and append `*_name` columns; this mapper
 * collapses missing names to `undefined` so the optional-field semantics
 * line up with the wire shape (omitted from JSON; UI falls back to the id).
 */
import type { StoreSettingsRow } from "../../db/schema/index.js";
import type { StoreSettings, SupportedLocale } from "./types.js";

export interface StoreSettingsRowWithRegions extends StoreSettingsRow {
  shippingOriginProvinsiName: string | null;
  shippingOriginKotaKabupatenName: string | null;
  shippingOriginKecamatanName: string | null;
  shippingOriginKelurahanName: string | null;
}

export function toStoreSettings(
  row: StoreSettingsRowWithRegions,
): StoreSettings {
  return {
    storeName: row.storeName,
    defaultCurrency: row.defaultCurrency,
    // The DB CHECK constraint pins this to ('id' | 'en'); the cast narrows
    // the column's loose `string` to the domain enum.
    defaultLocale: row.defaultLocale as SupportedLocale,

    defaultTaxRateId: row.defaultTaxRateId ?? null,

    shippingOriginProvinsiId: row.shippingOriginProvinsiId ?? null,
    shippingOriginKotaKabupatenId: row.shippingOriginKotaKabupatenId ?? null,
    shippingOriginKecamatanId: row.shippingOriginKecamatanId ?? null,
    shippingOriginKelurahanId: row.shippingOriginKelurahanId ?? null,
    shippingOriginPostalCode: row.shippingOriginPostalCode ?? null,
    shippingOriginAddressLine1: row.shippingOriginAddressLine1 ?? null,
    shippingOriginPhone: row.shippingOriginPhone ?? null,

    ...(row.shippingOriginProvinsiName !== null
      ? { shippingOriginProvinsiName: row.shippingOriginProvinsiName }
      : {}),
    ...(row.shippingOriginKotaKabupatenName !== null
      ? { shippingOriginKotaKabupatenName: row.shippingOriginKotaKabupatenName }
      : {}),
    ...(row.shippingOriginKecamatanName !== null
      ? { shippingOriginKecamatanName: row.shippingOriginKecamatanName }
      : {}),
    ...(row.shippingOriginKelurahanName !== null
      ? { shippingOriginKelurahanName: row.shippingOriginKelurahanName }
      : {}),

    notificationEmailEnabled: row.notificationEmailEnabled,
    notificationWhatsappEnabled: row.notificationWhatsappEnabled,

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

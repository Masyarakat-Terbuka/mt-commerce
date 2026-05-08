/**
 * Wire-shape helpers — convert the settings domain type to JSON-safe payloads.
 *
 * `Date` → ISO 8601 string; nothing exotic otherwise. The optional region
 * NAMES are emitted only when present (mirrors the customer-addresses
 * pattern) so older clients ignoring unknown keys are unaffected and new
 * clients can render `name ?? id`.
 */
import type { StoreSettings } from "../types.js";

export interface WireStoreSettings {
  storeName: string;
  defaultCurrency: string;
  defaultLocale: "id" | "en";

  defaultTaxRateId: string | null;

  shippingOriginProvinsiId: string | null;
  shippingOriginKotaKabupatenId: string | null;
  shippingOriginKecamatanId: string | null;
  shippingOriginKelurahanId: string | null;
  shippingOriginPostalCode: string | null;
  shippingOriginAddressLine1: string | null;
  shippingOriginPhone: string | null;

  shippingOriginProvinsiName?: string;
  shippingOriginKotaKabupatenName?: string;
  shippingOriginKecamatanName?: string;
  shippingOriginKelurahanName?: string;

  notificationEmailEnabled: boolean;
  notificationWhatsappEnabled: boolean;

  createdAt: string;
  updatedAt: string;
}

export function toWireStoreSettings(s: StoreSettings): WireStoreSettings {
  return {
    storeName: s.storeName,
    defaultCurrency: s.defaultCurrency,
    defaultLocale: s.defaultLocale,

    defaultTaxRateId: s.defaultTaxRateId,

    shippingOriginProvinsiId: s.shippingOriginProvinsiId,
    shippingOriginKotaKabupatenId: s.shippingOriginKotaKabupatenId,
    shippingOriginKecamatanId: s.shippingOriginKecamatanId,
    shippingOriginKelurahanId: s.shippingOriginKelurahanId,
    shippingOriginPostalCode: s.shippingOriginPostalCode,
    shippingOriginAddressLine1: s.shippingOriginAddressLine1,
    shippingOriginPhone: s.shippingOriginPhone,

    ...(s.shippingOriginProvinsiName !== undefined
      ? { shippingOriginProvinsiName: s.shippingOriginProvinsiName }
      : {}),
    ...(s.shippingOriginKotaKabupatenName !== undefined
      ? { shippingOriginKotaKabupatenName: s.shippingOriginKotaKabupatenName }
      : {}),
    ...(s.shippingOriginKecamatanName !== undefined
      ? { shippingOriginKecamatanName: s.shippingOriginKecamatanName }
      : {}),
    ...(s.shippingOriginKelurahanName !== undefined
      ? { shippingOriginKelurahanName: s.shippingOriginKelurahanName }
      : {}),

    notificationEmailEnabled: s.notificationEmailEnabled,
    notificationWhatsappEnabled: s.notificationWhatsappEnabled,

    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

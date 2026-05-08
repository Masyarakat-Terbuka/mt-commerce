/**
 * OpenAPI wire-shape schemas for the settings routes.
 *
 * The settings module has a single resource with two operations (GET and
 * PATCH); we register one component for the response (`StoreSettings`)
 * here so the route definitions can reference it by name in the spec.
 *
 * Runtime serialization still goes through `wire.ts`; this file is the
 * spec-side mirror.
 */
import { z } from "@hono/zod-openapi";

export const StoreSettingsWire = z
  .object({
    storeName: z.string(),
    defaultCurrency: z.string().regex(/^[A-Z]{3}$/),
    defaultLocale: z.enum(["id", "en"]),

    defaultTaxRateId: z.string().nullable(),

    shippingOriginProvinsiId: z.string().nullable(),
    shippingOriginKotaKabupatenId: z.string().nullable(),
    shippingOriginKecamatanId: z.string().nullable(),
    shippingOriginKelurahanId: z.string().nullable(),
    shippingOriginPostalCode: z.string().nullable(),
    shippingOriginAddressLine1: z.string().nullable(),
    shippingOriginPhone: z.string().nullable(),

    // Resolved region NAMES — sibling fields, optional so the wire shape
    // stays backwards-compatible (older clients ignore unknown keys).
    shippingOriginProvinsiName: z.string().optional(),
    shippingOriginKotaKabupatenName: z.string().optional(),
    shippingOriginKecamatanName: z.string().optional(),
    shippingOriginKelurahanName: z.string().optional(),

    notificationEmailEnabled: z.boolean(),
    notificationWhatsappEnabled: z.boolean(),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("StoreSettings");

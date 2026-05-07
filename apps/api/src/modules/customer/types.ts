/**
 * Customer module — domain types and Zod input schemas.
 *
 * Two layers, mirroring the catalog module:
 *
 *   1. Domain types (`Customer`, `CustomerAddress`, `Province`, `City`,
 *      `District`, `Subdistrict`, `Paginated<T>`) — clean shapes consumed by
 *      the rest of the system. Dates are `Date` instances; the route layer
 *      converts to ISO strings on the way out.
 *
 *   2. Zod schemas for HTTP-boundary validation. Source of truth for request
 *      shape; surfaced through the standard validation_error envelope.
 */
import { z } from "zod";

// ----------------------------------------------------------------------------
// Domain types
// ----------------------------------------------------------------------------

export type AddressKind = "shipping" | "billing";

export interface Customer {
  id: string;
  authUserId: string | null;
  email: string;
  displayName: string | null;
  phone: string | null;
  taxIdentifier: string | null;
  companyName: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CustomerAddress {
  id: string;
  customerId: string;
  kind: AddressKind;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  provinsiId: string;
  kotaKabupatenId: string;
  kecamatanId: string;
  kelurahanId: string | null;
  postalCode: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Province {
  id: string;
  code: string;
  name: string;
}

export interface City {
  id: string;
  provinsiId: string;
  code: string;
  name: string;
  /** "kota" or "kabupaten". */
  kind: string;
}

export interface District {
  id: string;
  kotaKabupatenId: string;
  code: string;
  name: string;
}

export interface Subdistrict {
  id: string;
  kecamatanId: string;
  code: string;
  name: string;
  postalCode: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ----------------------------------------------------------------------------
// Shared field schemas
// ----------------------------------------------------------------------------

/**
 * E.164 phone numbers: optional `+`, then a 1-9 country-code start, then
 * 1-14 digits (15 total max). The brief intentionally allows the leading `+`
 * to be omitted so client code may pass either `0812...` (national) or
 * `+62812...`. Normalization to E.164 happens at a higher layer when callers
 * need a canonical form; the storage layer keeps whatever was sent in.
 */
const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, {
    message: "phone must be a valid E.164 number (e.g. +6281234567890)",
  });

const postalCodeSchema = z
  .string()
  .regex(/^\d{5}$/, {
    message: "postalCode must be a 5-digit numeric string",
  });

const emailSchema = z.string().email().max(255);
const addressKindSchema = z.enum(["shipping", "billing"]);

// ----------------------------------------------------------------------------
// Customer Zod schemas
// ----------------------------------------------------------------------------

export const createCustomerSchema = z.object({
  email: emailSchema,
  displayName: z.string().min(1).max(200).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  taxIdentifier: z.string().min(1).max(64).nullable().optional(),
  companyName: z.string().min(1).max(200).nullable().optional(),
  /**
   * Optional auth-user link. Lets a sign-up flow attach a freshly minted
   * Better Auth user to a new customer record in one call. Until the FK is
   * added (see `customers.ts`), the value is stored as-is without referential
   * verification.
   */
  authUserId: z.string().min(1).max(100).nullable().optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    email: emailSchema.optional(),
    displayName: z.string().min(1).max(200).nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    taxIdentifier: z.string().min(1).max(64).nullable().optional(),
    companyName: z.string().min(1).max(200).nullable().optional(),
    authUserId: z.string().min(1).max(100).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// ----------------------------------------------------------------------------
// Address Zod schemas
// ----------------------------------------------------------------------------

export const createAddressSchema = z.object({
  kind: addressKindSchema,
  isDefaultShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
  recipientName: z.string().min(1).max(200),
  phone: phoneSchema,
  addressLine1: z.string().min(1).max(500),
  addressLine2: z.string().min(1).max(500).nullable().optional(),
  provinsiId: z.string().min(1).max(32),
  kotaKabupatenId: z.string().min(1).max(32),
  kecamatanId: z.string().min(1).max(32),
  kelurahanId: z.string().min(1).max(32).nullable().optional(),
  postalCode: postalCodeSchema,
  notes: z.string().max(1000).nullable().optional(),
});
export type CreateAddressInput = z.infer<typeof createAddressSchema>;

export const updateAddressSchema = z
  .object({
    kind: addressKindSchema.optional(),
    isDefaultShipping: z.boolean().optional(),
    isDefaultBilling: z.boolean().optional(),
    recipientName: z.string().min(1).max(200).optional(),
    phone: phoneSchema.optional(),
    addressLine1: z.string().min(1).max(500).optional(),
    addressLine2: z.string().min(1).max(500).nullable().optional(),
    provinsiId: z.string().min(1).max(32).optional(),
    kotaKabupatenId: z.string().min(1).max(32).optional(),
    kecamatanId: z.string().min(1).max(32).optional(),
    kelurahanId: z.string().min(1).max(32).nullable().optional(),
    postalCode: postalCodeSchema.optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "patch must include at least one field",
  });
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

export const setDefaultAddressSchema = z.object({
  kind: addressKindSchema,
});
export type SetDefaultAddressInput = z.infer<typeof setDefaultAddressSchema>;

// ----------------------------------------------------------------------------
// List queries
// ----------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const listCustomersQuerySchema = z.object({
  email: emailSchema.optional(),
  search: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const listKotaKabupatenQuerySchema = z.object({
  provinsiId: z.string().min(1).max(32),
});
export type ListKotaKabupatenQuery = z.infer<typeof listKotaKabupatenQuerySchema>;

export const listKecamatanQuerySchema = z.object({
  kotaKabupatenId: z.string().min(1).max(32),
});
export type ListKecamatanQuery = z.infer<typeof listKecamatanQuerySchema>;

export const listKelurahanQuerySchema = z.object({
  kecamatanId: z.string().min(1).max(32),
});
export type ListKelurahanQuery = z.infer<typeof listKelurahanQuerySchema>;

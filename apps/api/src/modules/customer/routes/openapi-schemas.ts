/**
 * Shared OpenAPI wire-shape schemas for the customer routes.
 *
 * Both `routes/admin.ts` and `routes/storefront.ts` reference the same JSON
 * shape for customers, addresses, and region rows, so we register each
 * OpenAPI component in one place. Runtime serialization still goes through
 * `wire.ts` helpers; these schemas are the spec-side mirror.
 */
import { z } from "@hono/zod-openapi";
import { paginated } from "../../../lib/openapi-shared.js";

export const CustomerWire = z
  .object({
    id: z.string(),
    authUserId: z.string().nullable(),
    email: z.string().email(),
    displayName: z.string().nullable(),
    phone: z.string().nullable(),
    taxIdentifier: z.string().nullable(),
    companyName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .openapi("Customer");

export const AddressWire = z
  .object({
    id: z.string(),
    customerId: z.string(),
    kind: z.enum(["shipping", "billing"]),
    isDefaultShipping: z.boolean(),
    isDefaultBilling: z.boolean(),
    recipientName: z.string(),
    phone: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    provinsiId: z.string(),
    kotaKabupatenId: z.string(),
    kecamatanId: z.string(),
    kelurahanId: z.string().nullable(),
    postalCode: z.string(),
    notes: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .openapi("CustomerAddress");

export const CustomerWithAddressesWire = CustomerWire.extend({
  addresses: z.array(AddressWire),
}).openapi("CustomerWithAddresses");

export const ProvinceWire = z
  .object({ id: z.string(), name: z.string() })
  .openapi("Province");

export const CityWire = z
  .object({
    id: z.string(),
    provinsiId: z.string(),
    name: z.string(),
    kind: z.string(),
  })
  .openapi("City");

export const DistrictWire = z
  .object({
    id: z.string(),
    kotaKabupatenId: z.string(),
    name: z.string(),
  })
  .openapi("District");

export const SubdistrictWire = z
  .object({
    id: z.string(),
    kecamatanId: z.string(),
    name: z.string(),
    postalCode: z.string(),
  })
  .openapi("Subdistrict");

export const PaginatedCustomerWire = paginated(CustomerWire).openapi("PaginatedCustomer");

export const AddressListEnvelope = z
  .object({ data: z.array(AddressWire) })
  .openapi("AddressList");

export const ProvinceListEnvelope = z
  .object({ data: z.array(ProvinceWire) })
  .openapi("ProvinceList");

export const CityListEnvelope = z
  .object({ data: z.array(CityWire) })
  .openapi("CityList");

export const DistrictListEnvelope = z
  .object({ data: z.array(DistrictWire) })
  .openapi("DistrictList");

export const SubdistrictListEnvelope = z
  .object({ data: z.array(SubdistrictWire) })
  .openapi("SubdistrictList");

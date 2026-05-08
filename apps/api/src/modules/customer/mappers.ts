/**
 * Drizzle row → domain type mappers for the customer module.
 *
 * The mapping is total: every column maps to a domain field, with `null`
 * defaults for nullable columns so callers never see `undefined`. The
 * inverse direction (domain → insert) is a simple field rename and lives at
 * the call sites, matching the pattern in the catalog module.
 */
import type {
  CustomerAddressRow,
  CustomerRow,
  KecamatanRow,
  KelurahanRow,
  KotaKabupatenRow,
  ProvinsiRow,
} from "../../db/schema/index.js";
import type {
  AddressKind,
  City,
  Customer,
  CustomerAddress,
  District,
  Province,
  Subdistrict,
} from "./types.js";

export function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    authUserId: row.authUserId ?? null,
    email: row.email,
    displayName: row.displayName ?? null,
    phone: row.phone ?? null,
    taxIdentifier: row.taxIdentifier ?? null,
    companyName: row.companyName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

export function toCustomerAddress(row: CustomerAddressRow): CustomerAddress {
  return {
    id: row.id,
    customerId: row.customerId,
    // The DB column is plain text gated by the `address_kind` enum; the
    // domain type narrows to the enum union.
    kind: row.kind as AddressKind,
    isDefaultShipping: row.isDefaultShipping,
    isDefaultBilling: row.isDefaultBilling,
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? null,
    provinsiId: row.provinsiId,
    kotaKabupatenId: row.kotaKabupatenId,
    kecamatanId: row.kecamatanId,
    kelurahanId: row.kelurahanId ?? null,
    postalCode: row.postalCode,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}

/**
 * Row shape returned by repository read paths that LEFT JOIN the four
 * region tables. Each `*_name` column comes from the joined table and
 * is `null` when the region row was missing (e.g. a deleted province
 * referenced by a stale address) — we collapse to `undefined` at the
 * domain edge so the optional-field semantics line up with the wire
 * shape (omitted from JSON, falls back to the id at the UI).
 */
export interface CustomerAddressRowWithRegions extends CustomerAddressRow {
  provinsiName: string | null;
  kotaKabupatenName: string | null;
  kecamatanName: string | null;
  kelurahanName: string | null;
}

export function toCustomerAddressWithRegions(
  row: CustomerAddressRowWithRegions,
): CustomerAddress {
  return {
    ...toCustomerAddress(row),
    ...(row.provinsiName !== null ? { provinsiName: row.provinsiName } : {}),
    ...(row.kotaKabupatenName !== null
      ? { kotaKabupatenName: row.kotaKabupatenName }
      : {}),
    ...(row.kecamatanName !== null
      ? { kecamatanName: row.kecamatanName }
      : {}),
    ...(row.kelurahanName !== null
      ? { kelurahanName: row.kelurahanName }
      : {}),
  };
}

export function toProvince(row: ProvinsiRow): Province {
  return {
    id: row.id,
    name: row.name,
  };
}

export function toCity(row: KotaKabupatenRow): City {
  return {
    id: row.id,
    provinsiId: row.provinsiId,
    name: row.name,
    kind: row.kind,
  };
}

export function toDistrict(row: KecamatanRow): District {
  return {
    id: row.id,
    kotaKabupatenId: row.kotaKabupatenId,
    name: row.name,
  };
}

export function toSubdistrict(row: KelurahanRow): Subdistrict {
  return {
    id: row.id,
    kecamatanId: row.kecamatanId,
    name: row.name,
    postalCode: row.postalCode,
  };
}

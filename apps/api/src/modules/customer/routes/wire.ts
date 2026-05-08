/**
 * Wire-shape helpers — convert customer domain types to JSON-safe payloads.
 *
 * Same rationale as the catalog wire layer: `Date` instances become ISO
 * 8601 strings, optional fields become `null` rather than missing keys, and
 * the wire shape is a typed contract that tests and OpenAPI generators can
 * lock down.
 */
import type {
  AddressKind,
  City,
  Customer,
  CustomerAddress,
  District,
  Province,
  Subdistrict,
} from "../types.js";

export interface WireCustomer {
  id: string;
  authUserId: string | null;
  email: string;
  displayName: string | null;
  phone: string | null;
  taxIdentifier: string | null;
  companyName: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireCustomerAddress {
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
  /**
   * Resolved region names. Sibling-of-id rather than a nested object so
   * older clients keep working — they only see fields they already know.
   * `undefined` (omitted from JSON) if the region row could not be
   * resolved at read time; the UI falls back to the id field in that case.
   */
  provinsiName?: string;
  kotaKabupatenName?: string;
  kecamatanName?: string;
  kelurahanName?: string;
  postalCode: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// `id` is the BPS code on every region wire shape — there is no separate
// `code` field. See `types.ts` for why.

export interface WireProvince {
  id: string;
  name: string;
}

export interface WireCity {
  id: string;
  provinsiId: string;
  name: string;
  kind: string;
}

export interface WireDistrict {
  id: string;
  kotaKabupatenId: string;
  name: string;
}

export interface WireSubdistrict {
  id: string;
  kecamatanId: string;
  name: string;
  postalCode: string;
}

export function toWireCustomer(c: Customer): WireCustomer {
  return {
    id: c.id,
    authUserId: c.authUserId,
    email: c.email,
    displayName: c.displayName,
    phone: c.phone,
    taxIdentifier: c.taxIdentifier,
    companyName: c.companyName,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
  };
}

export function toWireAddress(a: CustomerAddress): WireCustomerAddress {
  return {
    id: a.id,
    customerId: a.customerId,
    kind: a.kind,
    isDefaultShipping: a.isDefaultShipping,
    isDefaultBilling: a.isDefaultBilling,
    recipientName: a.recipientName,
    phone: a.phone,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    provinsiId: a.provinsiId,
    kotaKabupatenId: a.kotaKabupatenId,
    kecamatanId: a.kecamatanId,
    kelurahanId: a.kelurahanId,
    // Pass-through of resolved region names. Spread-with-conditional keeps
    // each field omitted from the JSON when undefined, so old clients
    // see the wire shape they already know.
    ...(a.provinsiName !== undefined ? { provinsiName: a.provinsiName } : {}),
    ...(a.kotaKabupatenName !== undefined
      ? { kotaKabupatenName: a.kotaKabupatenName }
      : {}),
    ...(a.kecamatanName !== undefined
      ? { kecamatanName: a.kecamatanName }
      : {}),
    ...(a.kelurahanName !== undefined
      ? { kelurahanName: a.kelurahanName }
      : {}),
    postalCode: a.postalCode,
    notes: a.notes,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    deletedAt: a.deletedAt ? a.deletedAt.toISOString() : null,
  };
}

export function toWireProvince(p: Province): WireProvince {
  return { id: p.id, name: p.name };
}

export function toWireCity(c: City): WireCity {
  return {
    id: c.id,
    provinsiId: c.provinsiId,
    name: c.name,
    kind: c.kind,
  };
}

export function toWireDistrict(d: District): WireDistrict {
  return {
    id: d.id,
    kotaKabupatenId: d.kotaKabupatenId,
    name: d.name,
  };
}

export function toWireSubdistrict(s: Subdistrict): WireSubdistrict {
  return {
    id: s.id,
    kecamatanId: s.kecamatanId,
    name: s.name,
    postalCode: s.postalCode,
  };
}

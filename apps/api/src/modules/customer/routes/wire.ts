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

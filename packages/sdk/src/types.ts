/**
 * Wire and domain types for `@mt-commerce/sdk`.
 *
 * Two parallel hierarchies live in this file:
 *
 *   - `Wire*` — the JSON shape the API returns on the wire. Money is
 *     `MoneyJSON = { amount: string; currency: string }` per ADR-0007 and
 *     timestamps are ISO 8601 strings.
 *
 *   - The exported domain types (Product, Variant, Category, ...) — the
 *     shape SDK consumers receive after `client.ts` has converted Money
 *     strings to bigints (`Money.fromJSON`) and ISO timestamps to `Date`
 *     instances.
 *
 * Hand-written rather than generated from OpenAPI in this round. The API's
 * per-route OpenAPI annotations are still TODO; once they ship we can
 * regenerate this file and delete the hand-rolled mirrors.
 */
import type { Money, MoneyJSON } from "@mt-commerce/core/money";

// ----------------------------------------------------------------------------
// Wire shapes — exact JSON received from the API
// ----------------------------------------------------------------------------

export type ProductStatus = "draft" | "active" | "archived";

export interface WireVariant {
  id: string;
  productId: string;
  sku: string;
  title: string | null;
  price: MoneyJSON;
  compareAtPrice: MoneyJSON | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireProduct {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  defaultCurrency: string;
  categoryIds: string[];
  variants: WireVariant[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WireCategory {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireProvince {
  id: string;
  name: string;
}

export interface WireCity {
  id: string;
  provinsiId: string;
  name: string;
  /** "kota" or "kabupaten". */
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

export interface WirePaginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WireListEnvelope<T> {
  data: T[];
}

// ----------------------------------------------------------------------------
// Domain shapes — what consumers receive after deserialization
// ----------------------------------------------------------------------------

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  title: string | null;
  price: Money;
  compareAtPrice: Money | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Product {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: ProductStatus;
  defaultCurrency: string;
  categoryIds: string[];
  variants: Variant[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Province {
  id: string;
  name: string;
}

export interface City {
  id: string;
  provinsiId: string;
  name: string;
  kind: string;
}

export interface District {
  id: string;
  kotaKabupatenId: string;
  name: string;
}

export interface Subdistrict {
  id: string;
  kecamatanId: string;
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
// Query inputs
// ----------------------------------------------------------------------------

export type ProductSort = "newest" | "oldest" | "price_asc" | "price_desc";

export interface ListProductsQuery {
  /** Filter by category slug (storefront-friendly; not category id). */
  categorySlug?: string;
  search?: string;
  /** Whole-currency-unit minimum price. */
  minPriceAmount?: bigint | string | number;
  maxPriceAmount?: bigint | string | number;
  page?: number;
  pageSize?: number;
  sort?: ProductSort;
}

export interface ListKotaKabupatenQuery {
  provinsiId: string;
}

export interface ListKecamatanQuery {
  kotaKabupatenId: string;
}

export interface ListKelurahanQuery {
  kecamatanId: string;
}

// ----------------------------------------------------------------------------
// Per-call options
// ----------------------------------------------------------------------------

export interface RequestOptions {
  /**
   * Override the default 5-second timeout. `0` disables the built-in timeout
   * entirely (the caller's `signal` is still honored).
   */
  timeoutMs?: number;
  /** Caller-controlled abort signal, composed with the timeout signal. */
  signal?: AbortSignal;
}

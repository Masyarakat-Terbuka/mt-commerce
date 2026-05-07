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
  /**
   * Optional on the wire to keep the SDK forward-compatible with older API
   * deployments (pre-`0006_product_images`). The client coalesces a missing
   * value to `null` on the domain side; consumers always receive a defined
   * `string | null`.
   */
  imageUrl?: string | null;
  imageAlt?: string | null;
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
  /**
   * Primary product image URL, or null when the product has no image yet.
   * The storefront falls back to a neutral placeholder so the layout is
   * stable regardless.
   */
  imageUrl: string | null;
  /** Alt text for `imageUrl`, or null when no image is set. */
  imageAlt: string | null;
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
  /**
   * Translation locale for product fields (`title`, `description`). Sent as
   * `?locale=<value>`. Omit to let the API fall back to `Accept-Language` /
   * its default. The shape stays a string rather than `Locale` because the
   * SDK is locale-set-agnostic — the API decides which codes are valid.
   */
  locale?: string;
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
// Admin auth
// ----------------------------------------------------------------------------

export type Role = "owner" | "admin" | "staff" | "viewer";

export interface WireAuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
}

export interface WireAuthMe {
  user: WireAuthUser;
  staff: {
    authUserId: string;
    role: Role;
    displayName: string | null;
  } | null;
}

export interface AuthMe {
  user: WireAuthUser;
  /**
   * The staff role of the caller. `null` when the auth account exists but has
   * no staff profile attached — they should not be allowed into the admin UI.
   */
  role: Role | null;
  /** Convenience: prefer the staff display name, fall back to user.name. */
  displayName: string;
}

export interface WireAuthSession {
  id: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuthSession {
  id: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface SignInInput {
  email: string;
  password: string;
}

// ----------------------------------------------------------------------------
// Admin products list
// ----------------------------------------------------------------------------

export interface AdminListProductsQuery {
  status?: ProductStatus;
  categoryId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: ProductSort;
  /** See `ListProductsQuery.locale` — same semantics on the admin surface. */
  locale?: string;
}

/**
 * Per-call options for storefront category and product-by-slug calls that
 * accept only the locale parameter. Kept separate from `ListProductsQuery`
 * so callers don't see filter fields they cannot use.
 */
export interface LocaleQuery {
  locale?: string;
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

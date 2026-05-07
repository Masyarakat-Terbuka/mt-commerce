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
// Cart wire shapes — mirror `apps/api/src/modules/cart/routes/wire.ts`
// ----------------------------------------------------------------------------

export type CartStatus = "active" | "abandoned" | "converted";

export interface WireCartItem {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  unitPrice: MoneyJSON;
  lineTotal: MoneyJSON;
  createdAt: string;
  updatedAt: string;
}

export interface WireCartTotals {
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  shipping: MoneyJSON;
  total: MoneyJSON;
}

export interface WireCart {
  id: string;
  customerId: string | null;
  currency: string;
  status: CartStatus;
  items: WireCartItem[];
  totals: WireCartTotals;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
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
// Cart domain shapes — Money is `Money` (bigint amount), dates are `Date`
// ----------------------------------------------------------------------------

export interface CartItem {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  /** Captured at add-time; catalog price changes do not silently re-price. */
  unitPrice: Money;
  /** Convenience: `unitPrice * quantity`, same currency as `unitPrice`. */
  lineTotal: Money;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartTotals {
  subtotal: Money;
  /** PPN placeholder; service contract owns the rate. */
  tax: Money;
  /** Always zero at v0.1. */
  shipping: Money;
  total: Money;
}

export interface Cart {
  id: string;
  customerId: string | null;
  /** ISO 4217 code; locked at first item add. */
  currency: string;
  status: CartStatus;
  items: CartItem[];
  totals: CartTotals;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ----------------------------------------------------------------------------
// Cart inputs
// ----------------------------------------------------------------------------

export interface CreateCartInput {
  /** ISO 4217 code; storefront passes its locale's currency. */
  currency: string;
}

export interface AddCartItemInput {
  variantId: string;
  quantity: number;
}

export interface UpdateCartItemInput {
  /** `0` is interpreted by the API as remove-line. */
  quantity: number;
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
// Admin write inputs
//
// Mirror the Zod schemas in `apps/api/src/modules/catalog/types.ts`. The API
// accepts `translations` as a locale-keyed object per ADR-0010. The default
// locale (`id`) is required on create; on update only the locales that are
// actually being changed need to be present.
//
// Money on inputs travels via string amounts so JSON.stringify never throws
// on a `bigint`. The client converts `bigint | string | number` to a decimal
// string at the boundary so callers can pass whichever form is natural at
// the call site.
// ----------------------------------------------------------------------------

/**
 * Locale code used by the admin write surface. A string union (not a wider
 * `string`) so TypeScript catches obvious typos at the call site; the API
 * rejects unknown locales server-side regardless.
 */
export type AdminLocale = "id" | "en";

export interface ProductTranslationFields {
  title: string;
  description?: string | null;
}

export interface ProductTranslationsCreateInput {
  /** Required on create — every product must carry the default locale. */
  id: ProductTranslationFields;
  en?: ProductTranslationFields;
}

export type ProductTranslationsUpdateInput = Partial<
  Record<AdminLocale, ProductTranslationFields | undefined>
>;

export interface VariantTranslationFields {
  title: string;
}

export type VariantTranslationsInput = Partial<
  Record<AdminLocale, VariantTranslationFields | undefined>
>;

export interface CategoryTranslationFields {
  name: string;
}

export interface CategoryTranslationsCreateInput {
  id: CategoryTranslationFields;
  en?: CategoryTranslationFields;
}

export type CategoryTranslationsUpdateInput = Partial<
  Record<AdminLocale, CategoryTranslationFields | undefined>
>;

/**
 * Money amount accepted on writes. Strings travel verbatim; numbers must be
 * safe integers; bigints are stringified at the SDK boundary so JSON
 * serialization never throws.
 */
export type MoneyAmountInput = bigint | string | number;

export interface CreateProductInput {
  slug: string;
  translations: ProductTranslationsCreateInput;
  status?: ProductStatus;
  defaultCurrency: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
  categoryIds?: string[];
}

export interface UpdateProductInput {
  slug?: string;
  translations?: ProductTranslationsUpdateInput;
  status?: ProductStatus;
  defaultCurrency?: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
  categoryIds?: string[];
}

export interface CreateVariantInput {
  sku: string;
  translations?: VariantTranslationsInput;
  priceAmount: MoneyAmountInput;
  priceCurrency?: string;
  compareAtAmount?: MoneyAmountInput;
}

export interface UpdateVariantInput {
  sku?: string;
  translations?: VariantTranslationsInput;
  priceAmount?: MoneyAmountInput;
  priceCurrency?: string;
  compareAtAmount?: MoneyAmountInput | null;
}

export interface CreateCategoryInput {
  slug: string;
  translations: CategoryTranslationsCreateInput;
  parentId?: string | null;
}

export interface UpdateCategoryInput {
  slug?: string;
  translations?: CategoryTranslationsUpdateInput;
  parentId?: string | null;
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

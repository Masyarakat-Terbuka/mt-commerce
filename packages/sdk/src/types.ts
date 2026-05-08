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
// Inventory wire and domain shapes — mirror
// `apps/api/src/modules/catalog/routes/wire.ts` (`WireInventoryLevel`).
//
// At v0.1 the API exposes only the adjust mutation
// (`POST /admin/v1/variants/{id}/inventory/adjust`) and returns the resulting
// level in the response body. There is no `GET` on inventory levels yet, so
// the SDK only carries the response shape and the mutation input — there is
// no `list` / `byVariant` reader. That gap is tracked against the v0.1
// catalog checklist line "Implement inventory adjustment endpoints with audit
// logging" and will close when the read surface and audit log land server-side.
// ----------------------------------------------------------------------------

export interface WireInventoryLevel {
  id: string;
  variantId: string;
  /** NULL until multi-location inventory lands; v0.1 is single-location. */
  locationId: string | null;
  available: number;
  reserved: number;
  updatedAt: string;
}

export interface InventoryLevel {
  id: string;
  variantId: string;
  locationId: string | null;
  available: number;
  reserved: number;
  updatedAt: Date;
}

export interface AdjustInventoryInput {
  /**
   * Signed integer; positive adds stock, negative removes. The API rejects
   * `0`, anything outside ±1,000,000, or any non-integer. The SDK forwards
   * the value verbatim; the API is the validation source of truth.
   */
  delta: number;
  /**
   * Optional free-form operator note (e.g. "received from supplier"). The
   * server trims it, caps at 500 chars, and persists it to the audit_log
   * row alongside the actor and the before/after counts. Omit (or pass an
   * empty value) to record an adjustment without a reason.
   */
  reason?: string;
}

// ----------------------------------------------------------------------------
// Inventory audit history — wire and domain shapes for one row of the
// `audit_log` filtered to entity_kind=`inventory`.
// ----------------------------------------------------------------------------

export type InventoryActorKind = "system" | "staff" | "customer";

export interface WireInventoryAuditEntry {
  id: string;
  variantId: string;
  action: string;
  actorKind: InventoryActorKind;
  actorId: string | null;
  /**
   * Inventory-specific details extracted from `details`. Null when the
   * persisted row is from an older or different action shape.
   */
  deltaApplied: number | null;
  before: number | null;
  after: number | null;
  /** Full persisted details blob, including any forward-compatible fields. */
  details: Record<string, unknown>;
  reason: string | null;
  createdAt: string;
}

export interface InventoryAuditEntry {
  id: string;
  variantId: string;
  action: string;
  actorKind: InventoryActorKind;
  actorId: string | null;
  deltaApplied: number | null;
  before: number | null;
  after: number | null;
  details: Record<string, unknown>;
  reason: string | null;
  createdAt: Date;
}

export interface AdminListInventoryQuery {
  productId?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminListInventoryAuditQuery {
  page?: number;
  pageSize?: number;
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
// Customer profile wire and domain shapes — mirror
// `apps/api/src/modules/customer/routes/wire.ts` (WireCustomer / Customer).
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Customer-address wire and domain shapes — mirror
// `apps/api/src/modules/customer/routes/wire.ts`. Storefront checkout reads
// the signed-in customer's saved addresses to populate the address-step
// selector; only the read-side surface is exposed in the SDK at v0.1.
// ----------------------------------------------------------------------------

export type AddressKind = "shipping" | "billing";

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

// ----------------------------------------------------------------------------
// Admin customer surface — wire and domain shapes for the embedded
// "customer + addresses" detail response, plus the admin-side write inputs.
// Mirrors `apps/api/src/modules/customer/routes/admin.ts`. Reads use the
// `Customer` / `CustomerAddress` shapes already declared above; only the
// detail envelope and admin-write inputs are new.
// ----------------------------------------------------------------------------

export interface WireCustomerWithAddresses extends WireCustomer {
  addresses: WireCustomerAddress[];
}

export interface CustomerWithAddresses extends Customer {
  addresses: CustomerAddress[];
}

export interface AdminListCustomersQuery {
  /** Exact-match email filter. Mutually compatible with `search`. */
  email?: string;
  /** Free-text search over name / email / phone. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminCreateCustomerInput {
  email: string;
  displayName?: string | null;
  phone?: string | null;
  taxIdentifier?: string | null;
  companyName?: string | null;
  /**
   * Optional auth-user link. The admin API accepts this so a freshly
   * provisioned auth identity can be attached at creation time; most admin
   * flows omit it.
   */
  authUserId?: string | null;
}

export interface AdminUpdateCustomerInput {
  email?: string;
  displayName?: string | null;
  phone?: string | null;
  taxIdentifier?: string | null;
  companyName?: string | null;
  authUserId?: string | null;
}

// ----------------------------------------------------------------------------
// Shipping wire and domain shapes — mirror
// `apps/api/src/modules/shipping/routes/wire.ts`. The storefront only needs
// the listing endpoint (and a quote helper for advanced flows); the broader
// admin-side surface stays out of the SDK at v0.1.
// ----------------------------------------------------------------------------

export type ShippingProviderKind = "manual" | "plugin";

export interface WireShippingMethod {
  id: string;
  code: string;
  name: string;
  providerKind: ShippingProviderKind;
  flatRate: MoneyJSON | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ShippingMethod {
  id: string;
  /** Stable operator-facing code, e.g. "MANUAL_FLAT", "JNE_REG". */
  code: string;
  name: string;
  providerKind: ShippingProviderKind;
  /** Required when `providerKind === 'manual'`; null for plugin methods. */
  flatRate: Money | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

// ----------------------------------------------------------------------------
// Checkout wire shapes — mirror
// `apps/api/src/modules/checkout/routes/wire.ts`. The state machine is
// re-declared as a string union to keep the SDK independent of the API
// package; if the server adds a state, this union is the single point of
// breakage.
// ----------------------------------------------------------------------------

export type CheckoutState =
  | "pending"
  | "awaiting_shipping"
  | "awaiting_payment"
  | "completed"
  | "failed";

export interface WireCheckout {
  id: string;
  cartId: string;
  customerId: string | null;
  state: CheckoutState;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  email: string | null;
  shippingMethodCode: string | null;
  shippingAmount: MoneyJSON | null;
  paymentMethod: string | null;
  cancellationReason: string | null;
  idempotencyKey: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Checkout {
  id: string;
  cartId: string;
  customerId: string | null;
  state: CheckoutState;
  shippingAddressId: string | null;
  billingAddressId: string | null;
  email: string | null;
  shippingMethodCode: string | null;
  shippingAmount: Money | null;
  paymentMethod: string | null;
  cancellationReason: string | null;
  /**
   * Echoes back the `Idempotency-Key` accepted on the most recent `complete`
   * call. Storefront callers do not consume this; it is surfaced for parity
   * with the API and for debugging.
   */
  idempotencyKey: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckoutEvent {
  id: string;
  checkoutId: string;
  fromState: CheckoutState | null;
  toState: CheckoutState;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface WireOrderIntentLine {
  variantId: string;
  quantity: number;
  unitPrice: MoneyJSON;
}

export interface WireOrderIntentTotals {
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  shipping: MoneyJSON;
  total: MoneyJSON;
}

export interface OrderIntentAddressSnapshot {
  id: string;
  customerId: string;
  kind: AddressKind;
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
}

export interface WireOrderIntent {
  id: string;
  checkoutId: string;
  cartSnapshot: WireOrderIntentLine[];
  totalsSnapshot: WireOrderIntentTotals;
  shippingAddressSnapshot: OrderIntentAddressSnapshot;
  billingAddressSnapshot: OrderIntentAddressSnapshot | null;
  email: string;
  shippingMethodCode: string;
  paymentMethod: string;
  createdAt: string;
}

export interface OrderIntentLine {
  variantId: string;
  quantity: number;
  unitPrice: Money;
}

export interface OrderIntentTotals {
  subtotal: Money;
  tax: Money;
  shipping: Money;
  total: Money;
}

export interface OrderIntent {
  id: string;
  checkoutId: string;
  cartSnapshot: OrderIntentLine[];
  totalsSnapshot: OrderIntentTotals;
  shippingAddressSnapshot: OrderIntentAddressSnapshot;
  billingAddressSnapshot: OrderIntentAddressSnapshot | null;
  email: string;
  shippingMethodCode: string;
  paymentMethod: string;
  createdAt: Date;
}

export interface CompleteCheckoutResult {
  checkout: Checkout;
  orderIntent: OrderIntent;
}

export interface WireCompleteCheckoutResult {
  checkout: WireCheckout;
  orderIntent: WireOrderIntent;
}

// ----------------------------------------------------------------------------
// Orders — admin surface only at v0.1. Mirrors
// `apps/api/src/modules/orders/routes/wire.ts`. The storefront-side
// `client.storefront.orders.*` lands as part of Track 1 — keeping the
// admin surface here lets ops/admin tooling consume the canonical type
// independently.
// ----------------------------------------------------------------------------

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "refunded";

export type OrderActorKind = "system" | "staff" | "customer";

export interface OrderAddressSnapshot {
  id: string;
  customerId: string;
  kind: AddressKind;
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
}

export interface WireOrderItem {
  id: string;
  orderId: string;
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: MoneyJSON;
  lineSubtotal: MoneyJSON;
  createdAt: string;
}

export interface WireOrder {
  id: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  status: OrderStatus;
  subtotal: MoneyJSON;
  tax: MoneyJSON;
  taxRateCode: string | null;
  taxRateBasisPoints: number | null;
  shipping: MoneyJSON;
  shippingMethodCode: string;
  total: MoneyJSON;
  shippingAddressSnapshot: OrderAddressSnapshot;
  billingAddressSnapshot: OrderAddressSnapshot | null;
  paymentMethod: string;
  items: WireOrderItem[];
  paidAt: string | null;
  fulfilledAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WireOrderStatusEvent {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorKind: OrderActorKind;
  actorId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  createdAt: Date;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  currency: string;
  status: OrderStatus;
  subtotal: Money;
  tax: Money;
  taxRateCode: string | null;
  taxRateBasisPoints: number | null;
  shipping: Money;
  shippingMethodCode: string;
  total: Money;
  shippingAddressSnapshot: OrderAddressSnapshot;
  billingAddressSnapshot: OrderAddressSnapshot | null;
  paymentMethod: string;
  items: OrderItem[];
  paidAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderStatusEvent {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorKind: OrderActorKind;
  actorId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

// ----------------------------------------------------------------------------
// Admin orders inputs
// ----------------------------------------------------------------------------

export interface AdminListOrdersQuery {
  status?: OrderStatus;
  customerId?: string;
  email?: string;
  /** ISO 8601 timestamp; coerced server-side. */
  createdFrom?: string | Date;
  createdTo?: string | Date;
  page?: number;
  pageSize?: number;
  /** Translation locale for line-item title resolution. */
  locale?: string;
}

export interface TransitionOrderInput {
  toStatus: OrderStatus;
  /** Free-form context attached to the audit row (provider tx id, tracking, etc). */
  details?: Record<string, unknown>;
}

export interface CancelOrderAdminInput {
  reason?: string | null;
}

// ----------------------------------------------------------------------------
// Checkout inputs
// ----------------------------------------------------------------------------

export interface StartCheckoutInput {
  cartId: string;
  /** Required for guests (no customer attached to the cart). */
  email?: string;
}

export interface SetCheckoutAddressesInput {
  shippingAddressId: string;
  /** Omit (or set null) to default the billing address to the shipping one. */
  billingAddressId?: string | null;
}

export interface SetCheckoutShippingInput {
  shippingMethodCode: string;
}

export interface CompleteCheckoutInput {
  /** v0.1 only accepts `"manual_bank_transfer"`; the API gates the rest. */
  paymentMethod: string;
  /**
   * Travels as the `Idempotency-Key` HTTP header. Re-using the same key on
   * a retry returns the original response without re-executing the
   * transition — the callsite generates one on first arrival at the
   * confirm step and keeps it stable across retries.
   */
  idempotencyKey: string;
}

export interface CancelCheckoutInput {
  reason?: string | null;
}

export interface ListShippingMethodsQuery {
  /**
   * Advisory at v0.1 — manual methods carry a single configured currency, so
   * the storefront passes the cart's currency to filter the list semantically
   * even though the server accepts any value here.
   */
  currency?: string;
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
// Storefront customer auth — what the customer-facing site needs from the
// `/storefront/v1/auth/*` and `/api/auth/*` endpoints. Mirrors the API's
// `MeStorefrontResponse` and the `register` / `signIn` Better Auth payloads.
// ----------------------------------------------------------------------------

export interface WireStorefrontCustomerSummary {
  id: string;
  email: string;
  displayName: string | null;
  phone: string | null;
}

export interface WireStorefrontMeResponse {
  user: WireAuthUser | null;
  /**
   * Optional in the wire shape so an older API deployment that has not yet
   * adopted the customer-summary projection (the server-side change that
   * lands together with this client surface) still parses cleanly. The
   * SDK coalesces a missing value to `null` on the domain side.
   */
  customer?: WireStorefrontCustomerSummary | null;
}

/**
 * Storefront-side `me()` payload. Customers do NOT have a staff role, so the
 * shape is narrower than the admin `AuthMe`. The `customer` field is the
 * piece that lets the storefront pass `customerId` into `/customer/me/*`
 * calls without a second round-trip.
 */
export interface StorefrontMe {
  /** `null` when no session is present (anonymous browse). */
  user: WireAuthUser | null;
  /** `null` for anonymous, or when the auth user has no linked customer. */
  customer: WireStorefrontCustomerSummary | null;
}

export interface SignUpInput {
  email: string;
  password: string;
  /**
   * Display name. Better Auth requires `name` on email/password sign-up; we
   * surface it as required here so callers cannot forget it.
   */
  name: string;
  /**
   * Optional phone, attached to the customer record after the user.create
   * hook runs. v0.1: not yet plumbed through Better Auth's sign-up payload —
   * see the SDK README for the gap. The field is reserved here so the
   * client surface stays stable when the plumbing lands.
   */
  phone?: string;
}

// ----------------------------------------------------------------------------
// Storefront customer profile and address inputs — mirror the Zod schemas in
// `apps/api/src/modules/customer/types.ts`. Fields are optional on update;
// every field accepts `null` where the API allows clearing.
// ----------------------------------------------------------------------------

export interface UpdateCustomerInput {
  email?: string;
  displayName?: string | null;
  phone?: string | null;
  taxIdentifier?: string | null;
  companyName?: string | null;
}

export type CreateAddressInput = {
  kind: AddressKind;
  isDefaultShipping?: boolean;
  isDefaultBilling?: boolean;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  provinsiId: string;
  kotaKabupatenId: string;
  kecamatanId: string;
  kelurahanId?: string | null;
  postalCode: string;
  notes?: string | null;
};

export type UpdateAddressInput = Partial<CreateAddressInput>;

export interface SetDefaultAddressInput {
  kind: AddressKind;
}

// ----------------------------------------------------------------------------
// Storefront orders — `me/orders`. The wire shape is the same `WireOrder`
// the admin surface returns; the storefront only needs the list and a
// by-orderNumber lookup at v0.1.
// ----------------------------------------------------------------------------

export interface ListMyOrdersQuery {
  page?: number;
  pageSize?: number;
  /** Translation locale for line-item title resolution. */
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

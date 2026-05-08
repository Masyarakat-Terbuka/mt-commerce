/**
 * `createClient` — the SDK entry point.
 *
 * Returns a typed object grouped by API surface:
 *
 *   client.storefront.products.list({ ... })
 *   client.storefront.products.bySlug("...")
 *   client.storefront.categories.list()
 *   client.storefront.regions.provinsi()
 *   client.storefront.regions.kotaKabupaten({ provinsiId })
 *   client.storefront.regions.kecamatan({ kotaKabupatenId })
 *   client.storefront.regions.kelurahan({ kecamatanId })
 *   client.storefront.regions.postalCode(code)
 *
 * Design notes:
 *
 *   - No runtime deps beyond `@mt-commerce/core`. We use the platform `fetch`
 *     so the same client works in Bun, Node 18+, the browser, and Cloudflare
 *     Workers without a polyfill.
 *
 *   - Money on the wire is `MoneyJSON = { amount: string; currency: string }`;
 *     we convert to `Money = { amount: bigint; currency: string }` at the
 *     deserialization boundary using `Money.fromJSON`. Consumers never see
 *     the string form.
 *
 *   - Errors funnel through `ApiError` with stable codes. Server envelopes
 *     pass through as-is; client-side failures (timeout, abort, transport,
 *     decode) get synthetic codes prefixed by their failure mode.
 *
 *   - 5-second default timeout, configurable per call. No retries — operators
 *     who need them can layer their own without fighting the client.
 */
import { fromJSON as moneyFromJSON } from "@mt-commerce/core/money";
import { ApiError, isApiErrorEnvelope } from "./errors.js";
import type {
  AddCartItemInput,
  AdjustInventoryInput,
  AdminCreateCustomerInput,
  AdminListCustomersQuery,
  AdminListInventoryAuditQuery,
  AdminListInventoryQuery,
  AdminListOrdersQuery,
  AdminListPaymentsQuery,
  AdminListProductsQuery,
  AdminListTaxRatesQuery,
  AdminUpdateCustomerInput,
  ApiKey,
  ApiKeyScope,
  ApiKeyWithSecret,
  AuthMe,
  AuthSession,
  CreateApiKeyInput,
  CancelCheckoutInput,
  CancelFulfillmentInput,
  CancelOrderAdminInput,
  CapturePaymentInput,
  Cart,
  CartItem,
  CartTotals,
  Category,
  Checkout,
  CompleteCheckoutInput,
  CompleteCheckoutResult,
  City,
  CreateAddressInput,
  Customer,
  CreateCartInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  CustomerAddress,
  CustomerWithAddresses,
  District,
  Fulfillment,
  InitiatePaymentInput,
  InventoryAuditEntry,
  InventoryLevel,
  ListFulfillmentsQuery,
  ListKecamatanQuery,
  ListKelurahanQuery,
  ListKotaKabupatenQuery,
  ListMyOrdersQuery,
  ListProductsQuery,
  ListShippingMethodsQuery,
  LocaleQuery,
  MarkFulfillmentShippedInput,
  MoneyAmountInput,
  Order,
  OrderIntent,
  OrderIntentLine,
  OrderIntentTotals,
  OrderItem,
  OrderStatusEvent,
  Paginated,
  Payment,
  PaymentAttempt,
  PaymentInitiateOutcome,
  PaymentWithAttempts,
  SetFulfillmentTrackingInput,
  Product,
  RefundPaymentInput,
  SetDefaultAddressInput,
  SignUpInput,
  StorefrontMe,
  StoreSettings,
  TaxRate,
  TransitionOrderInput,
  UpdateStoreSettingsInput,
  Province,
  RequestOptions,
  StaffListRow,
  UpsertStaffInput,
  SetCheckoutAddressesInput,
  SetCheckoutShippingInput,
  ShippingMethod,
  SignInInput,
  StartCheckoutInput,
  Subdistrict,
  UpdateAddressInput,
  UpdateCartItemInput,
  UpdateCategoryInput,
  UpdateCustomerInput,
  UpdateProductInput,
  UpdateVariantInput,
  Variant,
  WireApiKey,
  WireApiKeyCreated,
  WireAuthMe,
  WireAuthSession,
  WireStaffListRow,
  WireCart,
  WireCartItem,
  WireCartTotals,
  WireCategory,
  WireCheckout,
  WireCity,
  WireCompleteCheckoutResult,
  WireCustomer,
  WireCustomerAddress,
  WireCustomerWithAddresses,
  WireDistrict,
  WireFulfillment,
  WireInventoryAuditEntry,
  WireInventoryLevel,
  WireListEnvelope,
  WireOrder,
  WireOrderItem,
  WireOrderIntent,
  WireOrderIntentLine,
  WireOrderIntentTotals,
  WireOrderStatusEvent,
  WirePaginated,
  WirePayment,
  WirePaymentAttempt,
  WirePaymentInitiateOutcome,
  WirePaymentWithAttempts,
  WireProduct,
  WireProvince,
  WireShippingMethod,
  WireStorefrontMeResponse,
  WireStoreSettings,
  WireSubdistrict,
  WireTaxRate,
  WireVariant,
} from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Base URL of the API, e.g. "http://localhost:8000". No trailing slash needed. */
  baseUrl: string;
  /**
   * Optional fetch implementation. Defaults to the platform `globalThis.fetch`.
   * Tests pass a fake fetch through this hook.
   */
  fetch?: FetchLike;
  /** Default timeout in ms; overridable per call. Defaults to 5000. */
  defaultTimeoutMs?: number;
  /**
   * Instance-default translation locale (e.g. `"id"`, `"en"`). Sent on every
   * storefront catalog request unless a per-call `locale` overrides it. When
   * unset, the API falls back to `Accept-Language` and ultimately its default
   * locale. The pragmatic shape here is one client per locale rather than
   * threading the param through every call site.
   */
  locale?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

// ----------------------------------------------------------------------------
// Wire → domain conversions
// ----------------------------------------------------------------------------

function toVariant(w: WireVariant): Variant {
  return {
    id: w.id,
    productId: w.productId,
    sku: w.sku,
    title: w.title,
    price: moneyFromJSON(w.price),
    compareAtPrice: w.compareAtPrice ? moneyFromJSON(w.compareAtPrice) : null,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
  };
}

function toProduct(w: WireProduct): Product {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title,
    description: w.description,
    status: w.status,
    defaultCurrency: w.defaultCurrency,
    // Coalesce wire-optional image fields to `null`. An older API that
    // predates the `0006_product_images` migration omits these entirely;
    // newer ones send `string | null` explicitly. The domain shape stays
    // a strict `string | null` either way so callers do not branch on
    // "missing vs explicitly null".
    imageUrl: w.imageUrl ?? null,
    imageAlt: w.imageAlt ?? null,
    categoryIds: w.categoryIds,
    variants: w.variants.map(toVariant),
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
  };
}

// ----------------------------------------------------------------------------
// Admin auth — staff and API-key wire→domain conversions. Keep them with the
// other small mappers so the pattern is consistent (timestamps to `Date`,
// unknown enum values filtered out at the boundary).
// ----------------------------------------------------------------------------

const KNOWN_API_KEY_SCOPES = new Set<string>([
  "catalog:read",
  "catalog:write",
  "webhooks:receive",
]);

/**
 * Filter wire-side scope strings to the typed union the SDK exposes. An
 * older API that has gained a scope the SDK does not yet know about would
 * otherwise smuggle the unknown string into the domain shape; filtering
 * keeps the type sound. The complementary case (scope removed from the
 * SDK but still on a stored row) is the same shape — drop the unknown.
 */
function filterApiKeyScopes(scopes: string[]): ApiKeyScope[] {
  return scopes.filter((s): s is ApiKeyScope => KNOWN_API_KEY_SCOPES.has(s));
}

function toStaffListRow(w: WireStaffListRow): StaffListRow {
  return {
    authUserId: w.authUserId,
    role: w.role,
    displayName: w.displayName,
    email: w.email,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toApiKey(w: WireApiKey): ApiKey {
  return {
    id: w.id,
    name: w.name,
    scopes: filterApiKeyScopes(w.scopes),
    lastUsedAt: w.lastUsedAt ? new Date(w.lastUsedAt) : null,
    createdAt: new Date(w.createdAt),
    revokedAt: w.revokedAt ? new Date(w.revokedAt) : null,
  };
}

function toCategory(w: WireCategory): Category {
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    parentId: w.parentId,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toProvince(w: WireProvince): Province {
  return { id: w.id, name: w.name };
}

function toCity(w: WireCity): City {
  return {
    id: w.id,
    provinsiId: w.provinsiId,
    name: w.name,
    kind: w.kind,
  };
}

function toDistrict(w: WireDistrict): District {
  return {
    id: w.id,
    kotaKabupatenId: w.kotaKabupatenId,
    name: w.name,
  };
}

function toSubdistrict(w: WireSubdistrict): Subdistrict {
  return {
    id: w.id,
    kecamatanId: w.kecamatanId,
    name: w.name,
    postalCode: w.postalCode,
  };
}

/**
 * Convert the wire store settings to the SDK domain shape.
 *
 * Resolved region NAMES are sibling, optional fields. We forward only the
 * present ones (omit-when-undefined) so consumers can do
 * `s.shippingOriginProvinsiName ?? s.shippingOriginProvinsiId` without
 * special-casing "name === null".
 */
function toStoreSettings(w: WireStoreSettings): StoreSettings {
  return {
    storeName: w.storeName,
    defaultCurrency: w.defaultCurrency,
    defaultLocale: w.defaultLocale,

    defaultTaxRateId: w.defaultTaxRateId,

    shippingOriginProvinsiId: w.shippingOriginProvinsiId,
    shippingOriginKotaKabupatenId: w.shippingOriginKotaKabupatenId,
    shippingOriginKecamatanId: w.shippingOriginKecamatanId,
    shippingOriginKelurahanId: w.shippingOriginKelurahanId,
    shippingOriginPostalCode: w.shippingOriginPostalCode,
    shippingOriginAddressLine1: w.shippingOriginAddressLine1,
    shippingOriginPhone: w.shippingOriginPhone,

    ...(w.shippingOriginProvinsiName !== undefined
      ? { shippingOriginProvinsiName: w.shippingOriginProvinsiName }
      : {}),
    ...(w.shippingOriginKotaKabupatenName !== undefined
      ? { shippingOriginKotaKabupatenName: w.shippingOriginKotaKabupatenName }
      : {}),
    ...(w.shippingOriginKecamatanName !== undefined
      ? { shippingOriginKecamatanName: w.shippingOriginKecamatanName }
      : {}),
    ...(w.shippingOriginKelurahanName !== undefined
      ? { shippingOriginKelurahanName: w.shippingOriginKelurahanName }
      : {}),

    notificationEmailEnabled: w.notificationEmailEnabled,
    notificationWhatsappEnabled: w.notificationWhatsappEnabled,

    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toTaxRate(w: WireTaxRate): TaxRate {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    rateBasisPoints: w.rateBasisPoints,
    currency: w.currency,
    isDefault: w.isDefault,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    archivedAt: w.archivedAt ? new Date(w.archivedAt) : null,
  };
}

function toCartItem(w: WireCartItem): CartItem {
  return {
    id: w.id,
    cartId: w.cartId,
    variantId: w.variantId,
    quantity: w.quantity,
    unitPrice: moneyFromJSON(w.unitPrice),
    lineTotal: moneyFromJSON(w.lineTotal),
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toCartTotals(w: WireCartTotals): CartTotals {
  const subtotal = moneyFromJSON(w.subtotal);
  const tax = moneyFromJSON(w.tax);
  // `subtotalIncludingTax` is optional on the wire so an older API
  // deployment that hasn't shipped the field yet still parses cleanly;
  // we coalesce to `subtotal + tax` in that case so consumers always
  // receive a defined Money value.
  const subtotalIncludingTax = w.subtotalIncludingTax
    ? moneyFromJSON(w.subtotalIncludingTax)
    : { amount: subtotal.amount + tax.amount, currency: subtotal.currency };
  // `taxRate` (nested) is the canonical source; the flat fields are
  // mirrored for convenience. Read either; coalesce missing → null.
  const taxRate = w.taxRate ?? null;
  return {
    subtotal,
    tax,
    shipping: moneyFromJSON(w.shipping),
    subtotalIncludingTax,
    total: moneyFromJSON(w.total),
    taxRate,
    taxRateCode: w.taxRateCode ?? taxRate?.code ?? null,
    taxRateBasisPoints: w.taxRateBasisPoints ?? taxRate?.basisPoints ?? null,
  };
}

function toCart(w: WireCart): Cart {
  return {
    id: w.id,
    customerId: w.customerId,
    currency: w.currency,
    status: w.status,
    items: w.items.map(toCartItem),
    totals: toCartTotals(w.totals),
    expiresAt: new Date(w.expiresAt),
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toCustomer(w: WireCustomer): Customer {
  return {
    id: w.id,
    authUserId: w.authUserId,
    email: w.email,
    displayName: w.displayName,
    phone: w.phone,
    taxIdentifier: w.taxIdentifier,
    companyName: w.companyName,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
  };
}

function toCustomerAddress(w: WireCustomerAddress): CustomerAddress {
  return {
    id: w.id,
    customerId: w.customerId,
    kind: w.kind,
    isDefaultShipping: w.isDefaultShipping,
    isDefaultBilling: w.isDefaultBilling,
    recipientName: w.recipientName,
    phone: w.phone,
    addressLine1: w.addressLine1,
    addressLine2: w.addressLine2,
    provinsiId: w.provinsiId,
    kotaKabupatenId: w.kotaKabupatenId,
    kecamatanId: w.kecamatanId,
    kelurahanId: w.kelurahanId,
    // Pass-through of resolved region names. Optional on both sides, so
    // we omit the field entirely when the wire payload lacks it; that
    // keeps `addr.provinsiName ?? addr.provinsiId` clean at the call
    // site.
    ...(w.provinsiName !== undefined ? { provinsiName: w.provinsiName } : {}),
    ...(w.kotaKabupatenName !== undefined
      ? { kotaKabupatenName: w.kotaKabupatenName }
      : {}),
    ...(w.kecamatanName !== undefined
      ? { kecamatanName: w.kecamatanName }
      : {}),
    ...(w.kelurahanName !== undefined
      ? { kelurahanName: w.kelurahanName }
      : {}),
    postalCode: w.postalCode,
    notes: w.notes,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
  };
}

function toCustomerWithAddresses(
  w: WireCustomerWithAddresses,
): CustomerWithAddresses {
  return {
    ...toCustomer(w),
    addresses: w.addresses.map(toCustomerAddress),
  };
}

function toShippingMethod(w: WireShippingMethod): ShippingMethod {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    providerKind: w.providerKind,
    flatRate: w.flatRate ? moneyFromJSON(w.flatRate) : null,
    isActive: w.isActive,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
  };
}

function toCheckout(w: WireCheckout): Checkout {
  return {
    id: w.id,
    cartId: w.cartId,
    customerId: w.customerId,
    state: w.state,
    shippingAddressId: w.shippingAddressId,
    billingAddressId: w.billingAddressId,
    email: w.email,
    shippingMethodCode: w.shippingMethodCode,
    shippingAmount: w.shippingAmount ? moneyFromJSON(w.shippingAmount) : null,
    paymentMethod: w.paymentMethod,
    cancellationReason: w.cancellationReason,
    idempotencyKey: w.idempotencyKey,
    expiresAt: new Date(w.expiresAt),
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toOrderIntentLine(w: WireOrderIntentLine): OrderIntentLine {
  return {
    variantId: w.variantId,
    quantity: w.quantity,
    unitPrice: moneyFromJSON(w.unitPrice),
  };
}

function toOrderIntentTotals(w: WireOrderIntentTotals): OrderIntentTotals {
  return {
    subtotal: moneyFromJSON(w.subtotal),
    tax: moneyFromJSON(w.tax),
    shipping: moneyFromJSON(w.shipping),
    total: moneyFromJSON(w.total),
  };
}

function toOrderItem(w: WireOrderItem): OrderItem {
  return {
    id: w.id,
    orderId: w.orderId,
    variantId: w.variantId,
    sku: w.sku,
    title: w.title,
    quantity: w.quantity,
    unitPrice: moneyFromJSON(w.unitPrice),
    lineSubtotal: moneyFromJSON(w.lineSubtotal),
    createdAt: new Date(w.createdAt),
  };
}

function toOrder(w: WireOrder): Order {
  return {
    id: w.id,
    orderNumber: w.orderNumber,
    customerId: w.customerId,
    email: w.email,
    currency: w.currency,
    status: w.status,
    subtotal: moneyFromJSON(w.subtotal),
    tax: moneyFromJSON(w.tax),
    taxRateCode: w.taxRateCode,
    taxRateBasisPoints: w.taxRateBasisPoints,
    shipping: moneyFromJSON(w.shipping),
    shippingMethodCode: w.shippingMethodCode,
    total: moneyFromJSON(w.total),
    shippingAddressSnapshot: w.shippingAddressSnapshot,
    billingAddressSnapshot: w.billingAddressSnapshot,
    paymentMethod: w.paymentMethod,
    items: w.items.map(toOrderItem),
    // Older API deployments may not yet emit `fulfillments` on the wire.
    // Coalesce to `[]` so callers always see the field defined; the
    // bigint/Date conversion happens via `toFulfillment`.
    fulfillments: (w.fulfillments ?? []).map(toFulfillment),
    paidAt: w.paidAt ? new Date(w.paidAt) : null,
    fulfilledAt: w.fulfilledAt ? new Date(w.fulfilledAt) : null,
    cancelledAt: w.cancelledAt ? new Date(w.cancelledAt) : null,
    refundedAt: w.refundedAt ? new Date(w.refundedAt) : null,
    cancellationReason: w.cancellationReason,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toFulfillment(w: WireFulfillment): Fulfillment {
  return {
    id: w.id,
    orderId: w.orderId,
    shippingMethodId: w.shippingMethodId,
    status: w.status,
    trackingCode: w.trackingCode,
    trackedAt: w.trackedAt ? new Date(w.trackedAt) : null,
    deliveredAt: w.deliveredAt ? new Date(w.deliveredAt) : null,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toOrderStatusEvent(w: WireOrderStatusEvent): OrderStatusEvent {
  return {
    id: w.id,
    orderId: w.orderId,
    fromStatus: w.fromStatus,
    toStatus: w.toStatus,
    actorKind: w.actorKind,
    actorId: w.actorId,
    details: w.details,
    createdAt: new Date(w.createdAt),
  };
}

function toInventoryLevel(w: WireInventoryLevel): InventoryLevel {
  return {
    id: w.id,
    variantId: w.variantId,
    locationId: w.locationId,
    available: w.available,
    reserved: w.reserved,
    updatedAt: new Date(w.updatedAt),
  };
}

function toInventoryAuditEntry(
  w: WireInventoryAuditEntry,
): InventoryAuditEntry {
  return {
    id: w.id,
    variantId: w.variantId,
    action: w.action,
    actorKind: w.actorKind,
    actorId: w.actorId,
    deltaApplied: w.deltaApplied,
    before: w.before,
    after: w.after,
    details: w.details,
    reason: w.reason,
    createdAt: new Date(w.createdAt),
  };
}

function toOrderIntent(w: WireOrderIntent): OrderIntent {
  return {
    id: w.id,
    checkoutId: w.checkoutId,
    cartSnapshot: w.cartSnapshot.map(toOrderIntentLine),
    totalsSnapshot: toOrderIntentTotals(w.totalsSnapshot),
    shippingAddressSnapshot: w.shippingAddressSnapshot,
    billingAddressSnapshot: w.billingAddressSnapshot,
    email: w.email,
    shippingMethodCode: w.shippingMethodCode,
    paymentMethod: w.paymentMethod,
    createdAt: new Date(w.createdAt),
  };
}

function toPayment(w: WirePayment): Payment {
  return {
    id: w.id,
    orderId: w.orderId,
    provider: w.provider,
    providerRef: w.providerRef,
    amount: moneyFromJSON(w.amount),
    status: w.status,
    idempotencyKey: w.idempotencyKey,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
  };
}

function toPaymentAttempt(w: WirePaymentAttempt): PaymentAttempt {
  return {
    id: w.id,
    paymentId: w.paymentId,
    kind: w.kind,
    status: w.status,
    requestPayload: w.requestPayload,
    responsePayload: w.responsePayload,
    errorMessage: w.errorMessage,
    createdAt: new Date(w.createdAt),
  };
}

function toPaymentWithAttempts(
  w: WirePaymentWithAttempts,
): PaymentWithAttempts {
  return {
    ...toPayment(w),
    attempts: w.attempts.map(toPaymentAttempt),
  };
}

function toPaymentInitiateOutcome(
  w: WirePaymentInitiateOutcome,
): PaymentInitiateOutcome {
  switch (w.status) {
    case "redirect":
      // The wire shape marks `redirectUrl` optional for the union;
      // narrow at the boundary so consumers do not have to.
      if (!w.redirectUrl) {
        throw new ApiError({
          code: "decode_error",
          message: "Payment initiate outcome 'redirect' is missing redirectUrl.",
          status: 0,
        });
      }
      return {
        status: "redirect",
        paymentId: w.paymentId,
        redirectUrl: w.redirectUrl,
      };
    case "captured":
      return { status: "captured", paymentId: w.paymentId };
    case "pending":
      return { status: "pending", paymentId: w.paymentId };
  }
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Serialize a money amount accepted on admin write inputs to the wire form
 * (decimal integer string). The API's Zod `moneyAmountSchema` accepts both
 * `string` and `number`, but JSON.stringify throws on `bigint` — so we
 * normalize at the SDK boundary so callers can hand us whichever form is
 * natural at the call site (typically a `bigint` from `Money.amount`).
 *
 * Numbers must already be safe integers; the API's schema also rejects
 * non-integers, but a synchronous client-side throw produces a more useful
 * stack trace than a 422 round-trip.
 */
function serializeMoneyAmount(value: MoneyAmountInput): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError(
        "Money amount must be a finite integer (or bigint/string).",
      );
    }
    return value.toString();
  }
  // String — forward verbatim. The API validates the digit-only shape.
  return value;
}

/**
 * Strip `undefined` properties from a plain object so the serialized JSON
 * does not carry `"foo":null`-vs-missing ambiguity. We deliberately keep
 * `null` (the wire signal for "clear this field") and only drop keys whose
 * value is `undefined`.
 */
function omitUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Build the JSON body for variant create/update calls. Money fields collapse
 * through `serializeMoneyAmount` so the body is JSON-safe regardless of
 * whether the caller passed a `bigint` or a `string`.
 */
function serializeCreateVariantBody(
  input: CreateVariantInput,
): Record<string, unknown> {
  return omitUndefined({
    sku: input.sku,
    translations: input.translations,
    priceAmount: serializeMoneyAmount(input.priceAmount),
    priceCurrency: input.priceCurrency,
    compareAtAmount:
      input.compareAtAmount !== undefined
        ? serializeMoneyAmount(input.compareAtAmount)
        : undefined,
  });
}

function serializeUpdateVariantBody(
  patch: UpdateVariantInput,
): Record<string, unknown> {
  return omitUndefined({
    sku: patch.sku,
    translations: patch.translations,
    priceAmount:
      patch.priceAmount !== undefined
        ? serializeMoneyAmount(patch.priceAmount)
        : undefined,
    priceCurrency: patch.priceCurrency,
    // `null` on compareAtAmount is the explicit "clear" signal — preserve it.
    compareAtAmount:
      patch.compareAtAmount === undefined
        ? undefined
        : patch.compareAtAmount === null
          ? null
          : serializeMoneyAmount(patch.compareAtAmount),
  });
}

/**
 * Serialize a query object to URLSearchParams. Skips `undefined` and `null`,
 * stringifies bigints (storefront price filters), and forwards everything
 * else through `String()`. The API's storefront list-query schema uses
 * `z.coerce` so numbers arrive as strings just fine.
 */
function buildQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "bigint") {
      sp.set(key, value.toString());
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s.length === 0 ? "" : `?${s}`;
}

/**
 * Compose the caller's signal (if any) with a timeout signal. Returns
 * `undefined` when no timeout and no caller signal — passing `undefined`
 * to `fetch` is correct and avoids creating a controller we never use.
 *
 * The cleanup function clears the timeout to keep the event loop clean
 * after fast responses; without it a 5-second timer would block process
 * exit in short-lived scripts.
 */
function composeAbort(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
  const noTimeout = timeoutMs <= 0;
  if (noTimeout && !callerSignal) {
    return { signal: undefined, cleanup: () => {}, timedOut: () => false };
  }
  if (noTimeout && callerSignal) {
    return { signal: callerSignal, cleanup: () => {}, timedOut: () => false };
  }

  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    timedOut: () => didTimeOut,
  };
}

interface RequestContext {
  fetchImpl: FetchLike;
  baseUrl: string;
  defaultTimeoutMs: number;
  /**
   * When true (admin client), every request rides with `credentials: "include"`
   * so the Better Auth session cookie reaches the API across origins. Storefront
   * traffic stays anonymous and skips this — the storefront talks to public
   * read endpoints and never authenticates with a cookie in v0.1.
   */
  withCredentials: boolean;
  /**
   * Instance-default locale. Methods that accept `locale` per call resolve
   * `perCallLocale ?? ctx.defaultLocale ?? undefined`. `undefined` here means
   * "do not send `?locale=`" — the API resolves from `Accept-Language`.
   */
  defaultLocale: string | undefined;
}

/**
 * Resolve the locale for a single request: per-call wins, instance default
 * is the fallback. Returns `undefined` when neither is set so the query
 * builder can omit the param entirely.
 */
function resolveLocale(
  ctx: RequestContext,
  perCall: string | undefined,
): string | undefined {
  if (perCall !== undefined) return perCall;
  return ctx.defaultLocale;
}

interface RequestInternalOptions extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Per-request extra headers. Keys are forwarded verbatim and override any
   * defaults set by `request` (`accept`, `content-type`). Used for the
   * checkout idempotency key and the v0.1 stand-in customer header.
   */
  headers?: Record<string, string>;
}

async function request<T>(
  ctx: RequestContext,
  path: string,
  options: RequestInternalOptions | undefined,
): Promise<T> {
  const url = `${ctx.baseUrl}${path}`;
  const method = options?.method ?? "GET";
  const timeoutMs = options?.timeoutMs ?? ctx.defaultTimeoutMs;
  const callerAlreadyAborted = options?.signal?.aborted === true;
  if (callerAlreadyAborted) {
    throw new ApiError({
      code: "request_aborted",
      message: "Request was aborted before being sent.",
      status: 0,
    });
  }

  const { signal, cleanup, timedOut } = composeAbort(timeoutMs, options?.signal);

  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers[key] = value;
    }
  }

  let response: Response;
  try {
    response = await ctx.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.withCredentials ? { credentials: "include" as const } : {}),
      signal,
    });
  } catch (err) {
    cleanup();
    // Distinguish three kinds of failure:
    //   1. Our timeout fired   → "request_timeout"
    //   2. Caller's signal     → "request_aborted"
    //   3. Anything else       → "network_error"
    // `AbortError` is a DOMException with `name === "AbortError"` in every
    // current runtime, so we identify aborts by name rather than instanceof.
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError") {
      if (timedOut()) {
        throw new ApiError({
          code: "request_timeout",
          message: `Request to ${path} timed out after ${timeoutMs}ms.`,
          status: 0,
          cause: err,
        });
      }
      throw new ApiError({
        code: "request_aborted",
        message: `Request to ${path} was aborted.`,
        status: 0,
        cause: err,
      });
    }
    throw new ApiError({
      code: "network_error",
      message: `Network error contacting ${url}: ${(err as Error)?.message ?? "unknown"}`,
      status: 0,
      cause: err,
    });
  }
  cleanup();

  // Empty responses (204 No Content). The storefront read endpoints always
  // return JSON, but DELETE/PUT-like endpoints in future may not — handle
  // it now so the helper stays general.
  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ApiError({
        code: "decode_error",
        message: `Failed to parse JSON response from ${path}.`,
        status: response.status,
        cause: err,
      });
    }
  }

  if (!response.ok) {
    if (isApiErrorEnvelope(parsed)) {
      throw new ApiError({
        code: parsed.error.code,
        message: parsed.error.message,
        status: response.status,
        details: parsed.error.details ?? {},
      });
    }
    // Server returned a non-2xx without the standard envelope. Surface a
    // generic error so callers still get a typed throw rather than an
    // arbitrary success-shape decode failure downstream.
    throw new ApiError({
      code: "http_error",
      message: `HTTP ${response.status} from ${path}.`,
      status: response.status,
      details: parsed === undefined ? {} : { body: parsed },
    });
  }

  return parsed as T;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface StorefrontProductsApi {
  list(query?: ListProductsQuery, options?: RequestOptions): Promise<Paginated<Product>>;
  /**
   * `opts` is a unified bag — it carries both the optional translation
   * `locale` and the standard `RequestOptions` (timeout, signal). One
   * argument, fewer call-site shapes.
   */
  bySlug(slug: string, opts?: LocaleQuery & RequestOptions): Promise<Product>;
}

export interface StorefrontCategoriesApi {
  list(opts?: LocaleQuery & RequestOptions): Promise<Category[]>;
}

export interface StorefrontRegionsApi {
  provinsi(options?: RequestOptions): Promise<Province[]>;
  kotaKabupaten(query: ListKotaKabupatenQuery, options?: RequestOptions): Promise<City[]>;
  kecamatan(query: ListKecamatanQuery, options?: RequestOptions): Promise<District[]>;
  kelurahan(query: ListKelurahanQuery, options?: RequestOptions): Promise<Subdistrict[]>;
  postalCode(code: string, options?: RequestOptions): Promise<Subdistrict[]>;
}

export interface StorefrontCartApi {
  /** POST /storefront/v1/carts — create a guest cart in `currency`. */
  create(input: CreateCartInput, options?: RequestOptions): Promise<Cart>;
  /** GET /storefront/v1/carts/:id — fetch by id; 404 surfaces as ApiError. */
  byId(cartId: string, options?: RequestOptions): Promise<Cart>;
  /** POST /storefront/v1/carts/:id/items — add a line item, returns the cart. */
  addItem(
    cartId: string,
    input: AddCartItemInput,
    options?: RequestOptions,
  ): Promise<Cart>;
  /** PATCH /storefront/v1/carts/:id/items/:itemId — `quantity: 0` removes the line. */
  updateItem(
    cartId: string,
    itemId: string,
    input: UpdateCartItemInput,
    options?: RequestOptions,
  ): Promise<Cart>;
  /** DELETE /storefront/v1/carts/:id/items/:itemId. */
  removeItem(
    cartId: string,
    itemId: string,
    options?: RequestOptions,
  ): Promise<Cart>;
  /** POST /storefront/v1/carts/:id/clear — empties items, keeps the cart. */
  clear(cartId: string, options?: RequestOptions): Promise<Cart>;
}

export interface StorefrontShippingApi {
  /** GET /storefront/v1/shipping/methods?currency=IDR — active methods only. */
  methods(
    query?: ListShippingMethodsQuery,
    options?: RequestOptions,
  ): Promise<ShippingMethod[]>;
}

/**
 * `RequestOptions` augmented with a stand-in customer-id header. Storefront
 * customer-scoped reads (saved addresses, etc.) ride this header until the
 * customer-auth integration replaces it with a session cookie. Surfacing
 * the option on the SDK keeps callers from reaching past the abstraction
 * with their own `fetch`.
 */
export interface CustomerScopedOptions extends RequestOptions {
  customerId?: string;
}

export interface StorefrontCustomerProfileApi {
  /** GET /storefront/v1/customer/me — requires customerId stand-in (until session-based resolution lands server-side). */
  get(options?: CustomerScopedOptions): Promise<Customer>;
  /** PATCH /storefront/v1/customer/me — partial update; at least one field required. */
  update(
    patch: UpdateCustomerInput,
    options?: CustomerScopedOptions,
  ): Promise<Customer>;
}

export interface StorefrontCustomerAddressesApi {
  /** GET /storefront/v1/customer/me/addresses. */
  list(options?: CustomerScopedOptions): Promise<CustomerAddress[]>;
  /** POST /storefront/v1/customer/me/addresses. */
  create(
    input: CreateAddressInput,
    options?: CustomerScopedOptions,
  ): Promise<CustomerAddress>;
  /** PATCH /storefront/v1/customer/me/addresses/{id}. */
  update(
    addressId: string,
    patch: UpdateAddressInput,
    options?: CustomerScopedOptions,
  ): Promise<CustomerAddress>;
  /** DELETE /storefront/v1/customer/me/addresses/{id} (soft-delete). */
  remove(
    addressId: string,
    options?: CustomerScopedOptions,
  ): Promise<void>;
  /** PUT /storefront/v1/customer/me/addresses/{id}/default — set as default for kind. */
  setDefault(
    addressId: string,
    input: SetDefaultAddressInput,
    options?: CustomerScopedOptions,
  ): Promise<CustomerAddress>;
}

export interface StorefrontCustomerOrdersApi {
  /** GET /storefront/v1/customer/me/orders — newest first. */
  list(
    query?: ListMyOrdersQuery,
    options?: CustomerScopedOptions,
  ): Promise<Paginated<Order>>;
  /**
   * GET /storefront/v1/customer/me/orders/{orderNumber} — friendly handle
   * lookup. There is no by-id endpoint for customers at v0.1; the
   * order-number is the customer-facing identifier.
   */
  byNumber(
    orderNumber: string,
    options?: CustomerScopedOptions & LocaleQuery,
  ): Promise<Order>;
}

export interface StorefrontCustomerApi {
  profile: StorefrontCustomerProfileApi;
  addresses: StorefrontCustomerAddressesApi;
  orders: StorefrontCustomerOrdersApi;
  /**
   * Back-compat shim for the legacy `client.storefront.customer.myAddresses()`
   * call surface used by the existing checkout island. New code should call
   * `client.storefront.customer.addresses.list()`.
   *
   * @deprecated Use `addresses.list(...)` instead.
   */
  myAddresses(options?: CustomerScopedOptions): Promise<CustomerAddress[]>;
}

export interface StorefrontAuthApi {
  /**
   * POST /api/auth/sign-up/email (Better Auth). Creates a new auth user and,
   * via the after-create hook, a linked customer record. Returns the
   * authoritative `me` payload so callers know the customerId immediately.
   *
   * The `phone` field is reserved on the input shape but is NOT currently
   * forwarded to Better Auth's sign-up endpoint — the payload Better Auth
   * accepts is just `{ email, password, name }`. After sign-up the storefront
   * can call `customer.profile.update({ phone })` to attach it.
   */
  signUp(input: SignUpInput, options?: RequestOptions): Promise<StorefrontMe>;
  /** POST /api/auth/sign-in/email (Better Auth). Returns the `me` payload. */
  signIn(input: SignInInput, options?: RequestOptions): Promise<StorefrontMe>;
  /** POST /api/auth/sign-out (Better Auth). Drops the session cookie. */
  signOut(options?: RequestOptions): Promise<void>;
  /**
   * GET /storefront/v1/auth/me. Returns `{ user: null, customer: null }` for
   * an anonymous caller; otherwise the auth user and the linked customer
   * summary so the storefront can render its account header without an
   * extra round-trip.
   */
  me(options?: RequestOptions): Promise<StorefrontMe>;
}

export interface StorefrontCheckoutApi {
  /** POST /storefront/v1/checkouts — start from a cart. */
  start(input: StartCheckoutInput, options?: RequestOptions): Promise<Checkout>;
  /** GET /storefront/v1/checkouts/:id — re-fetch by id. */
  byId(checkoutId: string, options?: RequestOptions): Promise<Checkout>;
  /** PUT /storefront/v1/checkouts/:id/addresses → moves to awaiting_shipping. */
  setAddresses(
    checkoutId: string,
    input: SetCheckoutAddressesInput,
    options?: RequestOptions,
  ): Promise<Checkout>;
  /** PUT /storefront/v1/checkouts/:id/shipping → moves to awaiting_payment. */
  setShipping(
    checkoutId: string,
    input: SetCheckoutShippingInput,
    options?: RequestOptions,
  ): Promise<Checkout>;
  /**
   * POST /storefront/v1/checkouts/:id/complete — sends the `Idempotency-Key`
   * header. Replays return the original response without re-running the
   * underlying transition; this is the headline guarantee of the checkout
   * flow.
   */
  complete(
    checkoutId: string,
    input: CompleteCheckoutInput,
    options?: RequestOptions,
  ): Promise<CompleteCheckoutResult>;
  /** POST /storefront/v1/checkouts/:id/cancel — moves to failed. */
  cancel(
    checkoutId: string,
    input?: CancelCheckoutInput,
    options?: RequestOptions,
  ): Promise<Checkout>;
  /**
   * POST /storefront/v1/checkouts/:id/payment/initiate.
   *
   * Sends `Idempotency-Key`. Returns a redirect URL (hosted-checkout
   * flows), an immediate captured outcome, or a pending state. The
   * caller chooses what to render based on `outcome.status`.
   */
  initiatePayment(
    checkoutId: string,
    input: InitiatePaymentInput,
    options?: RequestOptions,
  ): Promise<PaymentInitiateOutcome>;
  /**
   * GET /storefront/v1/checkouts/:id/payment — fetch the payment row
   * attached to the order this checkout produced. 404 (surfaced as an
   * `ApiError` with `status === 404`) when no payment has been
   * initiated yet.
   */
  getPayment(checkoutId: string, options?: RequestOptions): Promise<Payment>;
}

export interface StorefrontApi {
  products: StorefrontProductsApi;
  categories: StorefrontCategoriesApi;
  regions: StorefrontRegionsApi;
  cart: StorefrontCartApi;
  checkout: StorefrontCheckoutApi;
  shipping: StorefrontShippingApi;
  customer: StorefrontCustomerApi;
  auth: StorefrontAuthApi;
}

// ---- Admin surface --------------------------------------------------------

export interface AdminAuthSessionsApi {
  list(options?: RequestOptions): Promise<AuthSession[]>;
  revoke(sessionId: string, options?: RequestOptions): Promise<void>;
}

/**
 * Owner-only staff roster + assignment surface. List + upsert mirror the
 * `/admin/v1/auth/staff` endpoints; both 403 if the caller is not an owner.
 */
export interface AdminAuthStaffApi {
  /** GET /admin/v1/auth/staff — every staff_profile row joined with the user's email. */
  list(options?: RequestOptions): Promise<StaffListRow[]>;
  /**
   * POST /admin/v1/auth/staff — create or update a staff_profile. Returns
   * the persisted row. The API enforces the first-staff-must-be-owner and
   * last-owner-protection invariants; both render through the standard
   * error envelope.
   */
  upsert(
    input: UpsertStaffInput,
    options?: RequestOptions,
  ): Promise<StaffListRow>;
}

/**
 * Owner/admin-only API-key management. The plaintext secret is returned
 * exactly once on `create`; subsequent `list` results never carry it.
 */
export interface AdminAuthApiKeysApi {
  /** GET /admin/v1/auth/api-keys — caller's API keys, newest first. */
  list(options?: RequestOptions): Promise<ApiKey[]>;
  /**
   * POST /admin/v1/auth/api-keys — issue a new key. The `secret` field on
   * the response is the bearer string (`<id>.<secret>`); store it
   * immediately, the server never returns it again.
   */
  create(
    input: CreateApiKeyInput,
    options?: RequestOptions,
  ): Promise<ApiKeyWithSecret>;
  /** DELETE /admin/v1/auth/api-keys/:id — soft-revoke. */
  revoke(id: string, options?: RequestOptions): Promise<void>;
}

export interface AdminAuthApi {
  me(options?: RequestOptions): Promise<AuthMe>;
  signIn(input: SignInInput, options?: RequestOptions): Promise<AuthMe>;
  signOut(options?: RequestOptions): Promise<void>;
  sessions: AdminAuthSessionsApi;
  staff: AdminAuthStaffApi;
  apiKeys: AdminAuthApiKeysApi;
}

export interface AdminProductsApi {
  list(
    query?: AdminListProductsQuery,
    options?: RequestOptions,
  ): Promise<Paginated<Product>>;
  byId(id: string, options?: RequestOptions): Promise<Product>;
  /** Create a product. Returns the persisted product (variants empty initially). */
  create(input: CreateProductInput, options?: RequestOptions): Promise<Product>;
  /** Patch a product. Translations merge per ADR-0010 — only locales sent are touched. */
  update(
    id: string,
    patch: UpdateProductInput,
    options?: RequestOptions,
  ): Promise<Product>;
  /** Soft-delete a product. The row stays in the database with `deletedAt` set. */
  delete(id: string, options?: RequestOptions): Promise<void>;
  /** Add a variant under an existing product. */
  createVariant(
    productId: string,
    input: CreateVariantInput,
    options?: RequestOptions,
  ): Promise<Variant>;
  /** Patch a variant. */
  updateVariant(
    variantId: string,
    patch: UpdateVariantInput,
    options?: RequestOptions,
  ): Promise<Variant>;
  /** Soft-delete a variant. */
  deleteVariant(variantId: string, options?: RequestOptions): Promise<void>;
}

export interface AdminCategoriesApi {
  list(options?: RequestOptions): Promise<Category[]>;
  create(input: CreateCategoryInput, options?: RequestOptions): Promise<Category>;
  update(
    id: string,
    patch: UpdateCategoryInput,
    options?: RequestOptions,
  ): Promise<Category>;
  delete(id: string, options?: RequestOptions): Promise<void>;
}

export interface AdminCustomersApi {
  /** GET /admin/v1/customers — paginated, soft-deleted excluded server-side. */
  list(
    query?: AdminListCustomersQuery,
    options?: RequestOptions,
  ): Promise<Paginated<Customer>>;
  /**
   * GET /admin/v1/customers/{id} — returns the customer alongside their
   * embedded addresses. We expose a single method (rather than a separate
   * `byIdWithAddresses`) because the API itself returns the union shape and
   * splitting it client-side would force a second round-trip.
   */
  byId(id: string, options?: RequestOptions): Promise<CustomerWithAddresses>;
  /** POST /admin/v1/customers — create a customer record. */
  create(
    input: AdminCreateCustomerInput,
    options?: RequestOptions,
  ): Promise<Customer>;
  /** PATCH /admin/v1/customers/{id} — partial update; at least one field. */
  update(
    id: string,
    patch: AdminUpdateCustomerInput,
    options?: RequestOptions,
  ): Promise<Customer>;
  /** DELETE /admin/v1/customers/{id} — soft-delete (sets deletedAt). */
  delete(id: string, options?: RequestOptions): Promise<void>;
  /** GET /admin/v1/customers/{id}/addresses — convenience for the detail view. */
  listAddresses(
    id: string,
    options?: RequestOptions,
  ): Promise<CustomerAddress[]>;
  /** POST /admin/v1/customers/{id}/addresses — staff-side address creation. */
  createAddress(
    customerId: string,
    input: CreateAddressInput,
    options?: RequestOptions,
  ): Promise<CustomerAddress>;
  /**
   * PATCH /admin/v1/addresses/{addressId} — note the address-rooted path:
   * the API resolves the owning customer from the row itself rather than
   * trusting a request-supplied owner id.
   */
  updateAddress(
    addressId: string,
    patch: UpdateAddressInput,
    options?: RequestOptions,
  ): Promise<CustomerAddress>;
  /** DELETE /admin/v1/addresses/{addressId} — soft-delete the address row. */
  deleteAddress(addressId: string, options?: RequestOptions): Promise<void>;
}

export interface AdminOrdersApi {
  list(
    query?: AdminListOrdersQuery,
    options?: RequestOptions,
  ): Promise<Paginated<Order>>;
  byId(
    id: string,
    options?: RequestOptions & LocaleQuery,
  ): Promise<Order>;
  byNumber(
    orderNumber: string,
    options?: RequestOptions & LocaleQuery,
  ): Promise<Order>;
  events(id: string, options?: RequestOptions): Promise<OrderStatusEvent[]>;
  transition(
    id: string,
    input: TransitionOrderInput,
    options?: RequestOptions & LocaleQuery,
  ): Promise<Order>;
  cancel(
    id: string,
    input: CancelOrderAdminInput,
    options?: RequestOptions & LocaleQuery,
  ): Promise<Order>;
}

export interface AdminInventoryApi {
  /**
   * Apply a signed delta to a variant's available stock.
   *
   * Server validation: integer, non-zero, |delta| ≤ 1,000,000. The API also
   * refuses an adjustment that would drive `available` below zero (returns
   * `409 conflict`). The returned `InventoryLevel` is the post-adjustment
   * state.
   *
   * The optional `reason` lands in the audit log next to the actor and the
   * before/after counts. A blank value is folded to "no reason supplied"
   * server-side.
   */
  adjust(
    variantId: string,
    input: AdjustInventoryInput,
    options?: RequestOptions,
  ): Promise<InventoryLevel>;
  /**
   * GET the inventory level for a single variant. Returns `null` if the
   * variant has no inventory row (the API replies 404; the SDK normalizes
   * "missing" into a null result so callers do not have to branch on
   * `ApiError.code === "not_found"` for the common case).
   */
  byVariantId(
    variantId: string,
    options?: RequestOptions,
  ): Promise<InventoryLevel | null>;
  /**
   * Paginated list of inventory rows. `productId` narrows to one product's
   * variants; without it, every variant's row is returned.
   */
  list(
    query?: AdminListInventoryQuery,
    options?: RequestOptions,
  ): Promise<Paginated<InventoryLevel>>;
  /**
   * Paginated audit history for a variant's inventory, newest first.
   */
  auditByVariantId(
    variantId: string,
    query?: AdminListInventoryAuditQuery,
    options?: RequestOptions,
  ): Promise<Paginated<InventoryAuditEntry>>;
}

export interface AdminPaymentsApi {
  /** GET /admin/v1/payments — paginated list with optional filters. */
  list(
    query?: AdminListPaymentsQuery,
    options?: RequestOptions,
  ): Promise<Paginated<Payment>>;
  /** GET /admin/v1/payments/:id — payment row + attempt history. */
  byId(
    id: string,
    options?: RequestOptions,
  ): Promise<PaymentWithAttempts>;
  /**
   * POST /admin/v1/payments/:id/capture. Sends `Idempotency-Key`.
   * Capture-on-initiate providers do not need this — it exists for
   * the authorise-then-capture flow.
   */
  capture(
    id: string,
    input: CapturePaymentInput,
    options?: RequestOptions,
  ): Promise<Payment>;
  /**
   * POST /admin/v1/payments/:id/refund. Sends `Idempotency-Key`.
   * Optional `amount` (decimal string, smallest currency unit) for
   * partial refunds; optional `reason` for the audit trail.
   */
  refund(
    id: string,
    input: RefundPaymentInput,
    options?: RequestOptions,
  ): Promise<Payment>;
}

/**
 * Admin-side fulfillment lifecycle controls.
 *
 * Surfaced as a sibling of `admin.orders` (rather than nested under it)
 * so the SDK shape mirrors the API: fulfillments are their own resource
 * with their own URLs. The API embeds `fulfillments` on the `Order`
 * response shape, so callers reading order details usually do NOT need
 * to call `list()` separately — the embed is the common path.
 */
export interface AdminFulfillmentsApi {
  /** GET /admin/v1/fulfillments?orderId= — typically returns one row per order at v0.1. */
  list(
    query: ListFulfillmentsQuery,
    options?: RequestOptions,
  ): Promise<Fulfillment[]>;
  /** GET /admin/v1/fulfillments/{id} — detail. */
  byId(id: string, options?: RequestOptions): Promise<Fulfillment>;
  /**
   * PATCH /admin/v1/fulfillments/{id}/tracking — set or clear the tracking
   * code without changing status. Pass `trackingCode: null` to clear.
   */
  setTracking(
    id: string,
    input: SetFulfillmentTrackingInput,
    options?: RequestOptions,
  ): Promise<Fulfillment>;
  /**
   * POST /admin/v1/fulfillments/{id}/mark-shipped — transitions
   * `pending → shipped` and stamps `tracked_at`. The optional `trackingCode`
   * is applied in the same operation.
   */
  markShipped(
    id: string,
    input?: MarkFulfillmentShippedInput,
    options?: RequestOptions,
  ): Promise<Fulfillment>;
  /**
   * POST /admin/v1/fulfillments/{id}/mark-delivered — transitions
   * `shipped → delivered` and stamps `delivered_at`. The API also nudges
   * the parent order from `paid → fulfilled` best-effort; the SDK does
   * not need to refetch the order separately for that side effect.
   */
  markDelivered(id: string, options?: RequestOptions): Promise<Fulfillment>;
  /**
   * POST /admin/v1/fulfillments/{id}/cancel — transitions to `cancelled`
   * with an optional reason captured on the audit row. Does NOT cancel
   * the parent order.
   */
  cancel(
    id: string,
    input?: CancelFulfillmentInput,
    options?: RequestOptions,
  ): Promise<Fulfillment>;
}

/**
 * Admin-side store settings.
 *
 * The settings row is a singleton — there is no `byId` here. The API
 * lazily inserts the default row on first read, so `get()` never
 * returns `null` and there is no "uninitialised" branch to handle.
 */
export interface AdminSettingsApi {
  /** GET /admin/v1/settings — returns the singleton, embedding region NAMES. */
  get(options?: RequestOptions): Promise<StoreSettings>;
  /**
   * PATCH /admin/v1/settings — partial update; at least one field. Pass
   * `null` to clear a nullable field (e.g. `defaultTaxRateId: null`).
   */
  update(
    patch: UpdateStoreSettingsInput,
    options?: RequestOptions,
  ): Promise<StoreSettings>;
}

/**
 * Admin-side tax surface — read-only at v0.1. The settings page uses
 * `list()` to populate the "default tax rate" Select. Mutations (create/
 * update/archive/set-default) live on the API but are not yet surfaced
 * through the SDK because there is no admin UI driving them.
 */
export interface AdminTaxApi {
  /** GET /admin/v1/tax/rates — `activeOnly` defaults true server-side. */
  list(
    query?: AdminListTaxRatesQuery,
    options?: RequestOptions,
  ): Promise<TaxRate[]>;
}

export interface AdminApi {
  auth: AdminAuthApi;
  products: AdminProductsApi;
  categories: AdminCategoriesApi;
  customers: AdminCustomersApi;
  orders: AdminOrdersApi;
  inventory: AdminInventoryApi;
  payments: AdminPaymentsApi;
  fulfillments: AdminFulfillmentsApi;
  settings: AdminSettingsApi;
  tax: AdminTaxApi;
}

export interface MtCommerceClient {
  storefront: StorefrontApi;
  admin: AdminApi;
}

export function createClient(options: ClientOptions): MtCommerceClient {
  const fetchImpl: FetchLike =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const ctx: RequestContext = {
    fetchImpl,
    baseUrl: trimTrailingSlash(options.baseUrl),
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    withCredentials: false,
    defaultLocale: options.locale,
  };
  // Admin context piggybacks on the same base URL but flips the credentials
  // flag so the session cookie travels on every call. Storefront traffic
  // stays cookieless.
  const adminCtx: RequestContext = { ...ctx, withCredentials: true };
  /**
   * Storefront-customer context — same base URL as `ctx`, with cookies
   * enabled. Used for `/storefront/v1/auth/*`, `/api/auth/*` (Better Auth
   * sign-up/in/out), `/storefront/v1/customer/me/*`, and the customer-side
   * orders surface. The split from `ctx` is deliberate: anonymous catalog
   * reads (which ride `ctx`) must not carry session cookies through CDN
   * caches that key on `Cookie`.
   */
  const customerCtx: RequestContext = { ...ctx, withCredentials: true };

  const storefront: StorefrontApi = {
    products: {
      async list(query, requestOptions) {
        const qs = buildQuery({
          categorySlug: query?.categorySlug,
          search: query?.search,
          minPriceAmount: query?.minPriceAmount,
          maxPriceAmount: query?.maxPriceAmount,
          page: query?.page,
          pageSize: query?.pageSize,
          sort: query?.sort,
          locale: resolveLocale(ctx, query?.locale),
        });
        const wire = await request<WirePaginated<WireProduct>>(
          ctx,
          `/storefront/v1/products${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toProduct),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async bySlug(slug, opts) {
        // `opts` mixes a per-call locale with the standard RequestOptions
        // (timeout/signal). Split them at the boundary: the locale shapes
        // the URL, the rest is forwarded to the request helper untouched.
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({ locale: resolveLocale(ctx, locale) });
        const wire = await request<WireProduct>(
          ctx,
          `/storefront/v1/products/${encodeURIComponent(slug)}${qs}`,
          requestOptions,
        );
        return toProduct(wire);
      },
    },
    categories: {
      async list(opts) {
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({ locale: resolveLocale(ctx, locale) });
        const wire = await request<WireListEnvelope<WireCategory>>(
          ctx,
          `/storefront/v1/categories${qs}`,
          requestOptions,
        );
        return wire.data.map(toCategory);
      },
    },
    regions: {
      async provinsi(requestOptions) {
        const wire = await request<WireListEnvelope<WireProvince>>(
          ctx,
          "/storefront/v1/regions/provinsi",
          requestOptions,
        );
        return wire.data.map(toProvince);
      },
      async kotaKabupaten(query, requestOptions) {
        const wire = await request<WireListEnvelope<WireCity>>(
          ctx,
          `/storefront/v1/regions/kota-kabupaten${buildQuery({
            provinsiId: query.provinsiId,
          })}`,
          requestOptions,
        );
        return wire.data.map(toCity);
      },
      async kecamatan(query, requestOptions) {
        const wire = await request<WireListEnvelope<WireDistrict>>(
          ctx,
          `/storefront/v1/regions/kecamatan${buildQuery({
            kotaKabupatenId: query.kotaKabupatenId,
          })}`,
          requestOptions,
        );
        return wire.data.map(toDistrict);
      },
      async kelurahan(query, requestOptions) {
        const wire = await request<WireListEnvelope<WireSubdistrict>>(
          ctx,
          `/storefront/v1/regions/kelurahan${buildQuery({
            kecamatanId: query.kecamatanId,
          })}`,
          requestOptions,
        );
        return wire.data.map(toSubdistrict);
      },
      async postalCode(code, requestOptions) {
        const wire = await request<WireListEnvelope<WireSubdistrict>>(
          ctx,
          `/storefront/v1/regions/postal-code/${encodeURIComponent(code)}`,
          requestOptions,
        );
        return wire.data.map(toSubdistrict);
      },
    },
    cart: {
      // The cart id itself is the bearer token in v0.1 (unguessable ULID),
      // so every method just URL-encodes it into the path. Money fields on
      // the response cross the wire→domain boundary via `toCart`, so consumers
      // receive `bigint` amounts and `Date` timestamps consistently with the
      // rest of the SDK.
      async create(input, requestOptions) {
        const wire = await request<WireCart>(ctx, "/storefront/v1/carts", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: input,
        });
        return toCart(wire);
      },
      async byId(cartId, requestOptions) {
        const wire = await request<WireCart>(
          ctx,
          `/storefront/v1/carts/${encodeURIComponent(cartId)}`,
          requestOptions,
        );
        return toCart(wire);
      },
      async addItem(cartId, input, requestOptions) {
        const wire = await request<WireCart>(
          ctx,
          `/storefront/v1/carts/${encodeURIComponent(cartId)}/items`,
          { ...(requestOptions ?? {}), method: "POST", body: input },
        );
        return toCart(wire);
      },
      async updateItem(cartId, itemId, input, requestOptions) {
        const wire = await request<WireCart>(
          ctx,
          `/storefront/v1/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(itemId)}`,
          { ...(requestOptions ?? {}), method: "PATCH", body: input },
        );
        return toCart(wire);
      },
      async removeItem(cartId, itemId, requestOptions) {
        const wire = await request<WireCart>(
          ctx,
          `/storefront/v1/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(itemId)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
        return toCart(wire);
      },
      async clear(cartId, requestOptions) {
        const wire = await request<WireCart>(
          ctx,
          `/storefront/v1/carts/${encodeURIComponent(cartId)}/clear`,
          { ...(requestOptions ?? {}), method: "POST" },
        );
        return toCart(wire);
      },
    },
    checkout: {
      // Bearer pattern matches cart: the checkout id itself authorizes every
      // mutation, so the SDK just URL-encodes it. The `complete` call layers
      // an `Idempotency-Key` header on top — that key is the only piece of
      // state the caller must keep stable across retries.
      async start(input, requestOptions) {
        const wire = await request<WireCheckout>(
          ctx,
          "/storefront/v1/checkouts",
          { ...(requestOptions ?? {}), method: "POST", body: input },
        );
        return toCheckout(wire);
      },
      async byId(checkoutId, requestOptions) {
        const wire = await request<WireCheckout>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}`,
          requestOptions,
        );
        return toCheckout(wire);
      },
      async setAddresses(checkoutId, input, requestOptions) {
        const wire = await request<WireCheckout>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/addresses`,
          { ...(requestOptions ?? {}), method: "PUT", body: input },
        );
        return toCheckout(wire);
      },
      async setShipping(checkoutId, input, requestOptions) {
        const wire = await request<WireCheckout>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/shipping`,
          { ...(requestOptions ?? {}), method: "PUT", body: input },
        );
        return toCheckout(wire);
      },
      async complete(checkoutId, input, requestOptions) {
        const { idempotencyKey, paymentMethod } = input;
        const wire = await request<WireCompleteCheckoutResult>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/complete`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: { paymentMethod },
            headers: { "Idempotency-Key": idempotencyKey },
          },
        );
        return {
          checkout: toCheckout(wire.checkout),
          orderIntent: toOrderIntent(wire.orderIntent),
        };
      },
      async cancel(checkoutId, input, requestOptions) {
        // The API accepts a missing or empty body; only send `{ reason }`
        // when the caller provided one so the body stays minimal.
        const body =
          input && input.reason !== undefined && input.reason !== null
            ? { reason: input.reason }
            : undefined;
        const wire = await request<WireCheckout>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/cancel`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            ...(body !== undefined ? { body } : {}),
          },
        );
        return toCheckout(wire);
      },
      async initiatePayment(checkoutId, input, requestOptions) {
        const { idempotencyKey, providerCode, metadata } = input;
        const wire = await request<WirePaymentInitiateOutcome>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/payment/initiate`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({ providerCode, metadata }),
            headers: { "Idempotency-Key": idempotencyKey },
          },
        );
        return toPaymentInitiateOutcome(wire);
      },
      async getPayment(checkoutId, requestOptions) {
        const wire = await request<WirePayment>(
          ctx,
          `/storefront/v1/checkouts/${encodeURIComponent(checkoutId)}/payment`,
          requestOptions,
        );
        return toPayment(wire);
      },
    },
    shipping: {
      async methods(query, requestOptions) {
        const qs = buildQuery({ currency: query?.currency });
        const wire = await request<WireListEnvelope<WireShippingMethod>>(
          ctx,
          `/storefront/v1/shipping/methods${qs}`,
          requestOptions,
        );
        return wire.data.map(toShippingMethod);
      },
    },
    // Storefront customer surface — profile, addresses, orders.
    //
    // Cookies travel on every call via `customerCtx`. The `customerId`
    // stand-in is forwarded as the `x-customer-id` header until the API's
    // session→customer resolution lands; once the API stops requiring the
    // header, the SDK becomes a no-op forwarder. Splitting `customerId` out
    // of `RequestOptions` keeps the call sites stable on both sides of the
    // server-side change.
    customer: {
      profile: {
        async get(options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireCustomer>(
            customerCtx,
            "/storefront/v1/customer/me",
            {
              ...requestOptions,
              ...(headers ? { headers } : {}),
            },
          );
          return toCustomer(wire);
        },
        async update(patch, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireCustomer>(
            customerCtx,
            "/storefront/v1/customer/me",
            {
              ...requestOptions,
              method: "PATCH",
              body: omitUndefined({
                email: patch.email,
                displayName: patch.displayName,
                phone: patch.phone,
                taxIdentifier: patch.taxIdentifier,
                companyName: patch.companyName,
              }),
              ...(headers ? { headers } : {}),
            },
          );
          return toCustomer(wire);
        },
      },
      addresses: {
        async list(options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireListEnvelope<WireCustomerAddress>>(
            customerCtx,
            "/storefront/v1/customer/me/addresses",
            {
              ...requestOptions,
              ...(headers ? { headers } : {}),
            },
          );
          return wire.data.map(toCustomerAddress);
        },
        async create(input, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireCustomerAddress>(
            customerCtx,
            "/storefront/v1/customer/me/addresses",
            {
              ...requestOptions,
              method: "POST",
              body: omitUndefined({
                kind: input.kind,
                isDefaultShipping: input.isDefaultShipping,
                isDefaultBilling: input.isDefaultBilling,
                recipientName: input.recipientName,
                phone: input.phone,
                addressLine1: input.addressLine1,
                addressLine2: input.addressLine2,
                provinsiId: input.provinsiId,
                kotaKabupatenId: input.kotaKabupatenId,
                kecamatanId: input.kecamatanId,
                kelurahanId: input.kelurahanId,
                postalCode: input.postalCode,
                notes: input.notes,
              }),
              ...(headers ? { headers } : {}),
            },
          );
          return toCustomerAddress(wire);
        },
        async update(addressId, patch, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireCustomerAddress>(
            customerCtx,
            `/storefront/v1/customer/me/addresses/${encodeURIComponent(addressId)}`,
            {
              ...requestOptions,
              method: "PATCH",
              body: omitUndefined({
                kind: patch.kind,
                isDefaultShipping: patch.isDefaultShipping,
                isDefaultBilling: patch.isDefaultBilling,
                recipientName: patch.recipientName,
                phone: patch.phone,
                addressLine1: patch.addressLine1,
                addressLine2: patch.addressLine2,
                provinsiId: patch.provinsiId,
                kotaKabupatenId: patch.kotaKabupatenId,
                kecamatanId: patch.kecamatanId,
                kelurahanId: patch.kelurahanId,
                postalCode: patch.postalCode,
                notes: patch.notes,
              }),
              ...(headers ? { headers } : {}),
            },
          );
          return toCustomerAddress(wire);
        },
        async remove(addressId, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          await request<unknown>(
            customerCtx,
            `/storefront/v1/customer/me/addresses/${encodeURIComponent(addressId)}`,
            {
              ...requestOptions,
              method: "DELETE",
              ...(headers ? { headers } : {}),
            },
          );
        },
        async setDefault(addressId, input, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const wire = await request<WireCustomerAddress>(
            customerCtx,
            `/storefront/v1/customer/me/addresses/${encodeURIComponent(addressId)}/default`,
            {
              ...requestOptions,
              method: "PUT",
              body: { kind: input.kind },
              ...(headers ? { headers } : {}),
            },
          );
          return toCustomerAddress(wire);
        },
      },
      orders: {
        async list(query, options) {
          const { customerId, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const qs = buildQuery({
            page: query?.page,
            pageSize: query?.pageSize,
            locale: resolveLocale(customerCtx, query?.locale),
          });
          const wire = await request<WirePaginated<WireOrder>>(
            customerCtx,
            `/storefront/v1/customer/me/orders${qs}`,
            {
              ...requestOptions,
              ...(headers ? { headers } : {}),
            },
          );
          return {
            data: wire.data.map(toOrder),
            total: wire.total,
            page: wire.page,
            pageSize: wire.pageSize,
          };
        },
        async byNumber(orderNumber, options) {
          const { customerId, locale, ...requestOptions } = options ?? {};
          const headers = customerId ? { "x-customer-id": customerId } : undefined;
          const qs = buildQuery({ locale: resolveLocale(customerCtx, locale) });
          const wire = await request<WireOrder>(
            customerCtx,
            `/storefront/v1/customer/me/orders/${encodeURIComponent(orderNumber)}${qs}`,
            {
              ...requestOptions,
              ...(headers ? { headers } : {}),
            },
          );
          return toOrder(wire);
        },
      },
      // Back-compat shim — keeps existing checkout-island callers working.
      // New code should call `addresses.list(...)` directly.
      async myAddresses(options) {
        const { customerId, ...requestOptions } = options ?? {};
        const headers = customerId ? { "x-customer-id": customerId } : undefined;
        const wire = await request<WireListEnvelope<WireCustomerAddress>>(
          customerCtx,
          "/storefront/v1/customer/me/addresses",
          {
            ...requestOptions,
            ...(headers ? { headers } : {}),
          },
        );
        return wire.data.map(toCustomerAddress);
      },
    },
    auth: {
      // Better Auth's sign-up/sign-in routes return their own payload shape.
      // We discard it and follow up with a `/storefront/v1/auth/me` call so
      // the SDK contract is uniform: every "you are now authenticated"
      // response is the canonical `StorefrontMe`. The cost is one extra
      // round-trip; the benefit is callers never need to think about
      // Better Auth's response shape (which can shift across versions).
      async signUp(input, requestOptions) {
        await request<unknown>(customerCtx, "/api/auth/sign-up/email", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: { email: input.email, password: input.password, name: input.name },
        });
        const wire = await request<WireStorefrontMeResponse>(
          customerCtx,
          "/storefront/v1/auth/me",
          requestOptions,
        );
        return {
          user: wire.user,
          customer: wire.customer ?? null,
        };
      },
      async signIn(input, requestOptions) {
        await request<unknown>(customerCtx, "/api/auth/sign-in/email", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: input,
        });
        const wire = await request<WireStorefrontMeResponse>(
          customerCtx,
          "/storefront/v1/auth/me",
          requestOptions,
        );
        return {
          user: wire.user,
          customer: wire.customer ?? null,
        };
      },
      async signOut(requestOptions) {
        await request<unknown>(customerCtx, "/api/auth/sign-out", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: {},
        });
      },
      async me(requestOptions) {
        const wire = await request<WireStorefrontMeResponse>(
          customerCtx,
          "/storefront/v1/auth/me",
          requestOptions,
        );
        return {
          user: wire.user,
          customer: wire.customer ?? null,
        };
      },
    },
  };

  // -------------------------------------------------------------------------
  // Admin surface
  //
  // Cookies travel on every request via `withCredentials: true`. The custom
  // `/admin/v1/auth/me` endpoint returns both the auth user and the staff
  // profile; we flatten that into a single `AuthMe` shape so consumers do
  // not have to ifs `staff` themselves before deciding whether to render the
  // shell.
  //
  // Sign-in and sign-out are owned by Better Auth at `/api/auth/*`. We post
  // JSON to `/sign-in/email` and `/sign-out`, then immediately follow up
  // with `me()` so the caller receives the role right away (the Better Auth
  // response shape is internal to the framework; callers should trust the
  // /me payload as the source of truth for role/displayName).
  // -------------------------------------------------------------------------

  const admin: AdminApi = {
    auth: {
      async me(requestOptions) {
        const wire = await request<WireAuthMe>(
          adminCtx,
          "/admin/v1/auth/me",
          requestOptions,
        );
        return {
          user: wire.user,
          role: wire.staff?.role ?? null,
          displayName: wire.staff?.displayName ?? wire.user.name,
        };
      },
      async signIn(input, requestOptions) {
        await request<unknown>(adminCtx, "/api/auth/sign-in/email", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: input,
        });
        // Fetch the staff profile straight after sign-in. The Better Auth
        // response does not carry our staff role; /me is authoritative.
        const wire = await request<WireAuthMe>(
          adminCtx,
          "/admin/v1/auth/me",
          requestOptions,
        );
        return {
          user: wire.user,
          role: wire.staff?.role ?? null,
          displayName: wire.staff?.displayName ?? wire.user.name,
        };
      },
      async signOut(requestOptions) {
        await request<unknown>(adminCtx, "/api/auth/sign-out", {
          ...(requestOptions ?? {}),
          method: "POST",
          // Better Auth accepts an empty JSON body; sending `{}` keeps the
          // content-type negotiation predictable across runtimes.
          body: {},
        });
      },
      sessions: {
        async list(requestOptions) {
          const wire = await request<WireListEnvelope<WireAuthSession>>(
            adminCtx,
            "/admin/v1/auth/sessions",
            requestOptions,
          );
          return wire.data.map((s) => ({
            id: s.id,
            expiresAt: new Date(s.expiresAt),
            ipAddress: s.ipAddress,
            userAgent: s.userAgent,
            createdAt: new Date(s.createdAt),
          }));
        },
        async revoke(sessionId, requestOptions) {
          await request<unknown>(
            adminCtx,
            `/admin/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
            { ...(requestOptions ?? {}), method: "DELETE" },
          );
        },
      },
      staff: {
        async list(requestOptions) {
          const wire = await request<WireListEnvelope<WireStaffListRow>>(
            adminCtx,
            "/admin/v1/auth/staff",
            requestOptions,
          );
          return wire.data.map(toStaffListRow);
        },
        async upsert(input, requestOptions) {
          // The API returns the bare staff profile without the joined
          // `email`. We coalesce to `null` on the domain side so the
          // returned row matches the `StaffListRow` shape callers
          // already render — they can refetch the list to pick up the
          // freshly-joined email if they need it for that row.
          const wire = await request<WireStaffListRow>(
            adminCtx,
            "/admin/v1/auth/staff",
            {
              ...(requestOptions ?? {}),
              method: "POST",
              body: {
                authUserId: input.authUserId,
                role: input.role,
                displayName: input.displayName,
              },
            },
          );
          return toStaffListRow({ ...wire, email: wire.email ?? null });
        },
      },
      apiKeys: {
        async list(requestOptions) {
          const wire = await request<WireListEnvelope<WireApiKey>>(
            adminCtx,
            "/admin/v1/auth/api-keys",
            requestOptions,
          );
          return wire.data.map(toApiKey);
        },
        async create(input, requestOptions) {
          // Forward only the API-supported fields. `expiresAt` is reserved
          // on the SDK input shape but the v0.1 API does not accept it; the
          // body is omitted to keep the request faithful to the documented
          // contract.
          const wire = await request<WireApiKeyCreated>(
            adminCtx,
            "/admin/v1/auth/api-keys",
            {
              ...(requestOptions ?? {}),
              method: "POST",
              body: { name: input.label, scopes: input.scopes },
            },
          );
          return {
            id: wire.id,
            name: wire.name,
            scopes: filterApiKeyScopes(wire.scopes),
            secret: wire.plaintext,
            lastUsedAt: null,
            createdAt: new Date(wire.createdAt),
            revokedAt: null,
          };
        },
        async revoke(id, requestOptions) {
          await request<unknown>(
            adminCtx,
            `/admin/v1/auth/api-keys/${encodeURIComponent(id)}`,
            { ...(requestOptions ?? {}), method: "DELETE" },
          );
        },
      },
    },
    products: {
      async list(query, requestOptions) {
        const qs = buildQuery({
          status: query?.status,
          categoryId: query?.categoryId,
          search: query?.search,
          page: query?.page,
          pageSize: query?.pageSize,
          sort: query?.sort,
          locale: resolveLocale(adminCtx, query?.locale),
        });
        const wire = await request<WirePaginated<WireProduct>>(
          adminCtx,
          `/admin/v1/products${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toProduct),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async byId(id, requestOptions) {
        const wire = await request<WireProduct>(
          adminCtx,
          `/admin/v1/products/${encodeURIComponent(id)}`,
          requestOptions,
        );
        return toProduct(wire);
      },
      async create(input, requestOptions) {
        const wire = await request<WireProduct>(adminCtx, "/admin/v1/products", {
          ...(requestOptions ?? {}),
          method: "POST",
          body: omitUndefined({
            slug: input.slug,
            translations: input.translations,
            status: input.status,
            defaultCurrency: input.defaultCurrency,
            imageUrl: input.imageUrl,
            imageAlt: input.imageAlt,
            categoryIds: input.categoryIds,
          }),
        });
        return toProduct(wire);
      },
      async update(id, patch, requestOptions) {
        const wire = await request<WireProduct>(
          adminCtx,
          `/admin/v1/products/${encodeURIComponent(id)}`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: omitUndefined({
              slug: patch.slug,
              translations: patch.translations,
              status: patch.status,
              defaultCurrency: patch.defaultCurrency,
              imageUrl: patch.imageUrl,
              imageAlt: patch.imageAlt,
              categoryIds: patch.categoryIds,
            }),
          },
        );
        return toProduct(wire);
      },
      async delete(id, requestOptions) {
        await request<unknown>(
          adminCtx,
          `/admin/v1/products/${encodeURIComponent(id)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
      },
      async createVariant(productId, input, requestOptions) {
        const wire = await request<WireVariant>(
          adminCtx,
          `/admin/v1/products/${encodeURIComponent(productId)}/variants`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: serializeCreateVariantBody(input),
          },
        );
        return toVariant(wire);
      },
      async updateVariant(variantId, patch, requestOptions) {
        const wire = await request<WireVariant>(
          adminCtx,
          `/admin/v1/variants/${encodeURIComponent(variantId)}`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: serializeUpdateVariantBody(patch),
          },
        );
        return toVariant(wire);
      },
      async deleteVariant(variantId, requestOptions) {
        await request<unknown>(
          adminCtx,
          `/admin/v1/variants/${encodeURIComponent(variantId)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
      },
    },
    categories: {
      async list(requestOptions) {
        const wire = await request<WireListEnvelope<WireCategory>>(
          adminCtx,
          "/admin/v1/categories",
          requestOptions,
        );
        return wire.data.map(toCategory);
      },
      async create(input, requestOptions) {
        const wire = await request<WireCategory>(
          adminCtx,
          "/admin/v1/categories",
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({
              slug: input.slug,
              translations: input.translations,
              parentId: input.parentId,
            }),
          },
        );
        return toCategory(wire);
      },
      async update(id, patch, requestOptions) {
        const wire = await request<WireCategory>(
          adminCtx,
          `/admin/v1/categories/${encodeURIComponent(id)}`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: omitUndefined({
              slug: patch.slug,
              translations: patch.translations,
              parentId: patch.parentId,
            }),
          },
        );
        return toCategory(wire);
      },
      async delete(id, requestOptions) {
        await request<unknown>(
          adminCtx,
          `/admin/v1/categories/${encodeURIComponent(id)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
      },
    },
    customers: {
      // Admin customer surface — straightforward CRUD over `/customers` and
      // `/addresses`. The detail endpoint embeds addresses in the same
      // response (the API does the join) so the editor screen does not need
      // a second round-trip to render its layout.
      async list(query, requestOptions) {
        const qs = buildQuery({
          email: query?.email,
          search: query?.search,
          page: query?.page,
          pageSize: query?.pageSize,
        });
        const wire = await request<WirePaginated<WireCustomer>>(
          adminCtx,
          `/admin/v1/customers${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toCustomer),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async byId(id, requestOptions) {
        const wire = await request<WireCustomerWithAddresses>(
          adminCtx,
          `/admin/v1/customers/${encodeURIComponent(id)}`,
          requestOptions,
        );
        return toCustomerWithAddresses(wire);
      },
      async create(input, requestOptions) {
        const wire = await request<WireCustomer>(
          adminCtx,
          "/admin/v1/customers",
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({
              email: input.email,
              displayName: input.displayName,
              phone: input.phone,
              taxIdentifier: input.taxIdentifier,
              companyName: input.companyName,
              authUserId: input.authUserId,
            }),
          },
        );
        return toCustomer(wire);
      },
      async update(id, patch, requestOptions) {
        const wire = await request<WireCustomer>(
          adminCtx,
          `/admin/v1/customers/${encodeURIComponent(id)}`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: omitUndefined({
              email: patch.email,
              displayName: patch.displayName,
              phone: patch.phone,
              taxIdentifier: patch.taxIdentifier,
              companyName: patch.companyName,
              authUserId: patch.authUserId,
            }),
          },
        );
        return toCustomer(wire);
      },
      async delete(id, requestOptions) {
        await request<unknown>(
          adminCtx,
          `/admin/v1/customers/${encodeURIComponent(id)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
      },
      async listAddresses(id, requestOptions) {
        const wire = await request<WireListEnvelope<WireCustomerAddress>>(
          adminCtx,
          `/admin/v1/customers/${encodeURIComponent(id)}/addresses`,
          requestOptions,
        );
        return wire.data.map(toCustomerAddress);
      },
      async createAddress(customerId, input, requestOptions) {
        const wire = await request<WireCustomerAddress>(
          adminCtx,
          `/admin/v1/customers/${encodeURIComponent(customerId)}/addresses`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({
              kind: input.kind,
              isDefaultShipping: input.isDefaultShipping,
              isDefaultBilling: input.isDefaultBilling,
              recipientName: input.recipientName,
              phone: input.phone,
              addressLine1: input.addressLine1,
              addressLine2: input.addressLine2,
              provinsiId: input.provinsiId,
              kotaKabupatenId: input.kotaKabupatenId,
              kecamatanId: input.kecamatanId,
              kelurahanId: input.kelurahanId,
              postalCode: input.postalCode,
              notes: input.notes,
            }),
          },
        );
        return toCustomerAddress(wire);
      },
      async updateAddress(addressId, patch, requestOptions) {
        const wire = await request<WireCustomerAddress>(
          adminCtx,
          `/admin/v1/addresses/${encodeURIComponent(addressId)}`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: omitUndefined({
              kind: patch.kind,
              isDefaultShipping: patch.isDefaultShipping,
              isDefaultBilling: patch.isDefaultBilling,
              recipientName: patch.recipientName,
              phone: patch.phone,
              addressLine1: patch.addressLine1,
              addressLine2: patch.addressLine2,
              provinsiId: patch.provinsiId,
              kotaKabupatenId: patch.kotaKabupatenId,
              kecamatanId: patch.kecamatanId,
              kelurahanId: patch.kelurahanId,
              postalCode: patch.postalCode,
              notes: patch.notes,
            }),
          },
        );
        return toCustomerAddress(wire);
      },
      async deleteAddress(addressId, requestOptions) {
        await request<unknown>(
          adminCtx,
          `/admin/v1/addresses/${encodeURIComponent(addressId)}`,
          { ...(requestOptions ?? {}), method: "DELETE" },
        );
      },
    },
    orders: {
      async list(query, requestOptions) {
        const qs = buildQuery({
          status: query?.status,
          customerId: query?.customerId,
          email: query?.email,
          orderNumber: query?.orderNumber,
          createdFrom:
            query?.createdFrom instanceof Date
              ? query.createdFrom.toISOString()
              : query?.createdFrom,
          createdTo:
            query?.createdTo instanceof Date
              ? query.createdTo.toISOString()
              : query?.createdTo,
          page: query?.page,
          pageSize: query?.pageSize,
          locale: resolveLocale(adminCtx, query?.locale),
        });
        const wire = await request<WirePaginated<WireOrder>>(
          adminCtx,
          `/admin/v1/orders${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toOrder),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async byId(id, opts) {
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({ locale: resolveLocale(adminCtx, locale) });
        const wire = await request<WireOrder>(
          adminCtx,
          `/admin/v1/orders/${encodeURIComponent(id)}${qs}`,
          requestOptions,
        );
        return toOrder(wire);
      },
      async byNumber(orderNumber, opts) {
        // The admin list endpoint accepts `?orderNumber=` for an exact
        // match, so the lookup is a single request that asks for at
        // most one row. A 404 ApiError surfaces when nothing matches —
        // callers can `try/catch` on `ApiError.status === 404` to
        // distinguish "no such order" from a transport failure.
        //
        // The server folds empty / whitespace `orderNumber` to "no
        // filter" and would happily return the newest order, which is
        // never what the caller wanted — refuse here so the bug stays
        // local instead of surfacing as a wrong-row response.
        const trimmed = orderNumber.trim();
        if (trimmed.length === 0) {
          throw new ApiError({
            code: "validation_error",
            message: "byNumber requires a non-empty order number.",
            status: 400,
          });
        }
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({
          orderNumber: trimmed,
          page: 1,
          pageSize: 1,
          locale: resolveLocale(adminCtx, locale),
        });
        const wire = await request<WirePaginated<WireOrder>>(
          adminCtx,
          `/admin/v1/orders${qs}`,
          requestOptions,
        );
        const match = wire.data[0];
        if (match) return toOrder(match);
        throw new ApiError({
          code: "not_found",
          message: `Order ${orderNumber} was not found.`,
          status: 404,
        });
      },
      async events(id, requestOptions) {
        const wire = await request<WireListEnvelope<WireOrderStatusEvent>>(
          adminCtx,
          `/admin/v1/orders/${encodeURIComponent(id)}/events`,
          requestOptions,
        );
        return wire.data.map(toOrderStatusEvent);
      },
      async transition(id, input, opts) {
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({ locale: resolveLocale(adminCtx, locale) });
        const wire = await request<WireOrder>(
          adminCtx,
          `/admin/v1/orders/${encodeURIComponent(id)}/transition${qs}`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({
              toStatus: input.toStatus,
              details: input.details,
            }),
          },
        );
        return toOrder(wire);
      },
      async cancel(id, input, opts) {
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({ locale: resolveLocale(adminCtx, locale) });
        const wire = await request<WireOrder>(
          adminCtx,
          `/admin/v1/orders/${encodeURIComponent(id)}/cancel${qs}`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({ reason: input.reason }),
          },
        );
        return toOrder(wire);
      },
    },
    inventory: {
      async adjust(variantId, input, requestOptions) {
        const wire = await request<WireInventoryLevel>(
          adminCtx,
          `/admin/v1/variants/${encodeURIComponent(variantId)}/inventory/adjust`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({
              delta: input.delta,
              reason: input.reason,
            }),
          },
        );
        return toInventoryLevel(wire);
      },
      async byVariantId(variantId, requestOptions) {
        try {
          const wire = await request<WireInventoryLevel>(
            adminCtx,
            `/admin/v1/variants/${encodeURIComponent(variantId)}/inventory`,
            requestOptions,
          );
          return toInventoryLevel(wire);
        } catch (err) {
          // 404 → null is the common case (no inventory row for this
          // variant). Anything else (auth failure, server error, transport)
          // bubbles up as ApiError so callers can react.
          if (err instanceof ApiError && err.status === 404) {
            return null;
          }
          throw err;
        }
      },
      async list(query, requestOptions) {
        const qs = buildQuery({
          productId: query?.productId,
          page: query?.page,
          pageSize: query?.pageSize,
        });
        const wire = await request<WirePaginated<WireInventoryLevel>>(
          adminCtx,
          `/admin/v1/inventory/levels${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toInventoryLevel),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async auditByVariantId(variantId, query, requestOptions) {
        const qs = buildQuery({
          page: query?.page,
          pageSize: query?.pageSize,
        });
        const wire = await request<WirePaginated<WireInventoryAuditEntry>>(
          adminCtx,
          `/admin/v1/variants/${encodeURIComponent(variantId)}/inventory/audit${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toInventoryAuditEntry),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
    },
    payments: {
      async list(query, requestOptions) {
        const qs = buildQuery({
          orderId: query?.orderId,
          status: query?.status,
          provider: query?.provider,
          page: query?.page,
          pageSize: query?.pageSize,
        });
        const wire = await request<WirePaginated<WirePayment>>(
          adminCtx,
          `/admin/v1/payments${qs}`,
          requestOptions,
        );
        return {
          data: wire.data.map(toPayment),
          total: wire.total,
          page: wire.page,
          pageSize: wire.pageSize,
        };
      },
      async byId(id, requestOptions) {
        const wire = await request<WirePaymentWithAttempts>(
          adminCtx,
          `/admin/v1/payments/${encodeURIComponent(id)}`,
          requestOptions,
        );
        return toPaymentWithAttempts(wire);
      },
      async capture(id, input, requestOptions) {
        const { idempotencyKey, amount } = input;
        const wire = await request<WirePayment>(
          adminCtx,
          `/admin/v1/payments/${encodeURIComponent(id)}/capture`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({ amount }),
            headers: { "Idempotency-Key": idempotencyKey },
          },
        );
        return toPayment(wire);
      },
      async refund(id, input, requestOptions) {
        const { idempotencyKey, amount, reason } = input;
        const wire = await request<WirePayment>(
          adminCtx,
          `/admin/v1/payments/${encodeURIComponent(id)}/refund`,
          {
            ...(requestOptions ?? {}),
            method: "POST",
            body: omitUndefined({ amount, reason }),
            headers: { "Idempotency-Key": idempotencyKey },
          },
        );
        return toPayment(wire);
      },
    },
    fulfillments: {
      async list(query, requestOptions) {
        const qs = buildQuery({ orderId: query.orderId });
        const wire = await request<WireListEnvelope<WireFulfillment>>(
          adminCtx,
          `/admin/v1/fulfillments${qs}`,
          requestOptions,
        );
        return wire.data.map(toFulfillment);
      },
      async byId(id, requestOptions) {
        const wire = await request<WireFulfillment>(
          adminCtx,
          `/admin/v1/fulfillments/${encodeURIComponent(id)}`,
          requestOptions,
        );
        return toFulfillment(wire);
      },
      async setTracking(id, input, requestOptions) {
        const wire = await request<WireFulfillment>(
          adminCtx,
          `/admin/v1/fulfillments/${encodeURIComponent(id)}/tracking`,
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            // Forward `null` literally — clearing the code is meaningful.
            body: { trackingCode: input.trackingCode },
          },
        );
        return toFulfillment(wire);
      },
      async markShipped(id, input, requestOptions) {
        const body =
          input?.trackingCode !== undefined
            ? { trackingCode: input.trackingCode }
            : {};
        const wire = await request<WireFulfillment>(
          adminCtx,
          `/admin/v1/fulfillments/${encodeURIComponent(id)}/mark-shipped`,
          { ...(requestOptions ?? {}), method: "POST", body },
        );
        return toFulfillment(wire);
      },
      async markDelivered(id, requestOptions) {
        const wire = await request<WireFulfillment>(
          adminCtx,
          `/admin/v1/fulfillments/${encodeURIComponent(id)}/mark-delivered`,
          { ...(requestOptions ?? {}), method: "POST", body: {} },
        );
        return toFulfillment(wire);
      },
      async cancel(id, input, requestOptions) {
        // Only send `{ reason }` when the caller supplied one; the API
        // tolerates both an empty body and `{ reason: null }`.
        const body =
          input && input.reason !== undefined && input.reason !== null
            ? { reason: input.reason }
            : {};
        const wire = await request<WireFulfillment>(
          adminCtx,
          `/admin/v1/fulfillments/${encodeURIComponent(id)}/cancel`,
          { ...(requestOptions ?? {}), method: "POST", body },
        );
        return toFulfillment(wire);
      },
    },
    settings: {
      async get(requestOptions) {
        const wire = await request<WireStoreSettings>(
          adminCtx,
          "/admin/v1/settings",
          requestOptions,
        );
        return toStoreSettings(wire);
      },
      async update(patch, requestOptions) {
        // `omitUndefined` keeps `null` (the explicit clear signal) and
        // drops only unset keys, matching the API's PATCH semantics.
        const wire = await request<WireStoreSettings>(
          adminCtx,
          "/admin/v1/settings",
          {
            ...(requestOptions ?? {}),
            method: "PATCH",
            body: omitUndefined({
              storeName: patch.storeName,
              defaultCurrency: patch.defaultCurrency,
              defaultLocale: patch.defaultLocale,
              defaultTaxRateId: patch.defaultTaxRateId,
              shippingOriginProvinsiId: patch.shippingOriginProvinsiId,
              shippingOriginKotaKabupatenId: patch.shippingOriginKotaKabupatenId,
              shippingOriginKecamatanId: patch.shippingOriginKecamatanId,
              shippingOriginKelurahanId: patch.shippingOriginKelurahanId,
              shippingOriginPostalCode: patch.shippingOriginPostalCode,
              shippingOriginAddressLine1: patch.shippingOriginAddressLine1,
              shippingOriginPhone: patch.shippingOriginPhone,
              notificationEmailEnabled: patch.notificationEmailEnabled,
              notificationWhatsappEnabled: patch.notificationWhatsappEnabled,
            }),
          },
        );
        return toStoreSettings(wire);
      },
    },
    tax: {
      async list(query, requestOptions) {
        const qs = buildQuery({ activeOnly: query?.activeOnly });
        const wire = await request<WireListEnvelope<WireTaxRate>>(
          adminCtx,
          `/admin/v1/tax/rates${qs}`,
          requestOptions,
        );
        return wire.data.map(toTaxRate);
      },
    },
  };

  return { storefront, admin };
}

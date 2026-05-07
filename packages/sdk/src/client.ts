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
  AdminListOrdersQuery,
  AdminListProductsQuery,
  AuthMe,
  AuthSession,
  CancelCheckoutInput,
  CancelOrderAdminInput,
  Cart,
  CartItem,
  CartTotals,
  Category,
  Checkout,
  CompleteCheckoutInput,
  CompleteCheckoutResult,
  City,
  CreateCartInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  CustomerAddress,
  District,
  ListKecamatanQuery,
  ListKelurahanQuery,
  ListKotaKabupatenQuery,
  ListProductsQuery,
  ListShippingMethodsQuery,
  LocaleQuery,
  MoneyAmountInput,
  Order,
  OrderIntent,
  OrderIntentLine,
  OrderIntentTotals,
  OrderItem,
  OrderStatusEvent,
  Paginated,
  Product,
  TransitionOrderInput,
  Province,
  RequestOptions,
  SetCheckoutAddressesInput,
  SetCheckoutShippingInput,
  ShippingMethod,
  SignInInput,
  StartCheckoutInput,
  Subdistrict,
  UpdateCartItemInput,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateVariantInput,
  Variant,
  WireAuthMe,
  WireAuthSession,
  WireCart,
  WireCartItem,
  WireCartTotals,
  WireCategory,
  WireCheckout,
  WireCity,
  WireCompleteCheckoutResult,
  WireCustomerAddress,
  WireDistrict,
  WireListEnvelope,
  WireOrder,
  WireOrderItem,
  WireOrderIntent,
  WireOrderIntentLine,
  WireOrderIntentTotals,
  WireOrderStatusEvent,
  WirePaginated,
  WireProduct,
  WireProvince,
  WireShippingMethod,
  WireSubdistrict,
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
  return {
    subtotal: moneyFromJSON(w.subtotal),
    tax: moneyFromJSON(w.tax),
    shipping: moneyFromJSON(w.shipping),
    total: moneyFromJSON(w.total),
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
    postalCode: w.postalCode,
    notes: w.notes,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    deletedAt: w.deletedAt ? new Date(w.deletedAt) : null,
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
    paidAt: w.paidAt ? new Date(w.paidAt) : null,
    fulfilledAt: w.fulfilledAt ? new Date(w.fulfilledAt) : null,
    cancelledAt: w.cancelledAt ? new Date(w.cancelledAt) : null,
    refundedAt: w.refundedAt ? new Date(w.refundedAt) : null,
    cancellationReason: w.cancellationReason,
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

export interface StorefrontCustomerApi {
  /** GET /storefront/v1/customer/me/addresses — requires customerId stand-in. */
  myAddresses(options?: CustomerScopedOptions): Promise<CustomerAddress[]>;
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
}

export interface StorefrontApi {
  products: StorefrontProductsApi;
  categories: StorefrontCategoriesApi;
  regions: StorefrontRegionsApi;
  cart: StorefrontCartApi;
  checkout: StorefrontCheckoutApi;
  shipping: StorefrontShippingApi;
  customer: StorefrontCustomerApi;
}

// ---- Admin surface --------------------------------------------------------

export interface AdminAuthSessionsApi {
  list(options?: RequestOptions): Promise<AuthSession[]>;
  revoke(sessionId: string, options?: RequestOptions): Promise<void>;
}

export interface AdminAuthApi {
  me(options?: RequestOptions): Promise<AuthMe>;
  signIn(input: SignInInput, options?: RequestOptions): Promise<AuthMe>;
  signOut(options?: RequestOptions): Promise<void>;
  sessions: AdminAuthSessionsApi;
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

export interface AdminApi {
  auth: AdminAuthApi;
  products: AdminProductsApi;
  categories: AdminCategoriesApi;
  orders: AdminOrdersApi;
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
    customer: {
      async myAddresses(options) {
        // Split the customer-id stand-in out of the standard RequestOptions
        // bag so it lands in the per-request headers map without polluting
        // the request signature once auth replaces this stand-in.
        const { customerId, ...requestOptions } = options ?? {};
        const headers = customerId ? { "x-customer-id": customerId } : undefined;
        const wire = await request<WireListEnvelope<WireCustomerAddress>>(
          ctx,
          "/storefront/v1/customer/me/addresses",
          {
            ...requestOptions,
            ...(headers ? { headers } : {}),
          },
        );
        return wire.data.map(toCustomerAddress);
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
    orders: {
      async list(query, requestOptions) {
        const qs = buildQuery({
          status: query?.status,
          customerId: query?.customerId,
          email: query?.email,
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
        // The admin API does not yet expose a `/orders/by-number/...`
        // shortcut — the number is unique, so we look it up via the list
        // filter and surface a 404 ApiError if the page is empty. A
        // dedicated endpoint can be added when admin tooling needs it.
        const { locale, ...requestOptions } = opts ?? {};
        const qs = buildQuery({
          locale: resolveLocale(adminCtx, locale),
          pageSize: 1,
          // The list endpoint does not currently filter by orderNumber,
          // so we emulate it by fetching the full set and matching the
          // string client-side. Acceptable at v0.1 because order_number
          // is rare on the admin landing page (most lookups are by id);
          // the filter parameter can be added to the API later without
          // breaking this signature.
        });
        const wire = await request<WirePaginated<WireOrder>>(
          adminCtx,
          `/admin/v1/orders${qs}`,
          requestOptions,
        );
        const match = wire.data.find((o) => o.orderNumber === orderNumber);
        if (!match) {
          throw new ApiError({
            code: "not_found",
            message: `Order ${orderNumber} was not found.`,
            status: 404,
          });
        }
        return toOrder(match);
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
  };

  return { storefront, admin };
}

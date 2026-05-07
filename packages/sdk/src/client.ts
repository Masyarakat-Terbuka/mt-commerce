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
  AdminListProductsQuery,
  AuthMe,
  AuthSession,
  Cart,
  CartItem,
  CartTotals,
  Category,
  City,
  CreateCartInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  District,
  ListKecamatanQuery,
  ListKelurahanQuery,
  ListKotaKabupatenQuery,
  ListProductsQuery,
  LocaleQuery,
  MoneyAmountInput,
  Paginated,
  Product,
  Province,
  RequestOptions,
  SignInInput,
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
  WireCity,
  WireDistrict,
  WireListEnvelope,
  WirePaginated,
  WireProduct,
  WireProvince,
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
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
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

export interface StorefrontApi {
  products: StorefrontProductsApi;
  categories: StorefrontCategoriesApi;
  regions: StorefrontRegionsApi;
  cart: StorefrontCartApi;
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

export interface AdminApi {
  auth: AdminAuthApi;
  products: AdminProductsApi;
  categories: AdminCategoriesApi;
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
  };

  return { storefront, admin };
}

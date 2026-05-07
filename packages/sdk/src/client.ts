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
  Category,
  City,
  District,
  ListKecamatanQuery,
  ListKelurahanQuery,
  ListKotaKabupatenQuery,
  ListProductsQuery,
  Paginated,
  Product,
  Province,
  RequestOptions,
  Subdistrict,
  Variant,
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

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
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
}

async function request<T>(
  ctx: RequestContext,
  path: string,
  options: RequestOptions | undefined,
): Promise<T> {
  const url = `${ctx.baseUrl}${path}`;
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

  let response: Response;
  try {
    response = await ctx.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
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
  bySlug(slug: string, options?: RequestOptions): Promise<Product>;
}

export interface StorefrontCategoriesApi {
  list(options?: RequestOptions): Promise<Category[]>;
}

export interface StorefrontRegionsApi {
  provinsi(options?: RequestOptions): Promise<Province[]>;
  kotaKabupaten(query: ListKotaKabupatenQuery, options?: RequestOptions): Promise<City[]>;
  kecamatan(query: ListKecamatanQuery, options?: RequestOptions): Promise<District[]>;
  kelurahan(query: ListKelurahanQuery, options?: RequestOptions): Promise<Subdistrict[]>;
  postalCode(code: string, options?: RequestOptions): Promise<Subdistrict[]>;
}

export interface StorefrontApi {
  products: StorefrontProductsApi;
  categories: StorefrontCategoriesApi;
  regions: StorefrontRegionsApi;
}

export interface MtCommerceClient {
  storefront: StorefrontApi;
}

export function createClient(options: ClientOptions): MtCommerceClient {
  const fetchImpl: FetchLike =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const ctx: RequestContext = {
    fetchImpl,
    baseUrl: trimTrailingSlash(options.baseUrl),
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

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
      async bySlug(slug, requestOptions) {
        const wire = await request<WireProduct>(
          ctx,
          `/storefront/v1/products/${encodeURIComponent(slug)}`,
          requestOptions,
        );
        return toProduct(wire);
      },
    },
    categories: {
      async list(requestOptions) {
        const wire = await request<WireListEnvelope<WireCategory>>(
          ctx,
          "/storefront/v1/categories",
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
  };

  return { storefront };
}

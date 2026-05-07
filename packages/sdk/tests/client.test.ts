/**
 * Tests for `createClient`.
 *
 * We pass a fake `fetch` implementation through the factory rather than
 * patching `globalThis.fetch`. This keeps each test hermetic and lets us
 * inspect the URL, query string, and request init that the client built.
 */
import { describe, it, expect } from "vitest";
import { ApiError, createClient, type FetchLike } from "../src/index.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockOptions {
  status?: number;
  body?: unknown;
  /**
   * If set, the mock fetch never resolves (or only rejects when its signal
   * aborts). Used to drive the timeout path.
   */
  hang?: boolean;
}

function mockFetch(opts: MockOptions): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({ url: input, init });
    if (opts.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
        // No resolution — relies on abort/timeout to settle.
      });
    }
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    return Promise.resolve(
      new Response(text, {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch, calls };
}

const sampleProductsPayload = {
  data: [
    {
      id: "prod_abc",
      slug: "kopi-arabika-gayo-200g",
      title: "Kopi Arabika Gayo 200g",
      description: "Kopi arabika dari Gayo.",
      status: "active",
      defaultCurrency: "IDR",
      categoryIds: ["cat_kopi"],
      variants: [
        {
          id: "var_abc",
          productId: "prod_abc",
          sku: "GAYO-200-WHOLE",
          title: "Biji utuh",
          price: { amount: "95000", currency: "IDR" },
          compareAtPrice: null,
          createdAt: "2026-04-12T08:00:00.000Z",
          updatedAt: "2026-04-12T08:00:00.000Z",
          deletedAt: null,
        },
      ],
      createdAt: "2026-04-12T08:00:00.000Z",
      updatedAt: "2026-04-12T08:00:00.000Z",
      deletedAt: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

describe("createClient — storefront.products.list", () => {
  it("returns a paginated result with bigint-converted Money", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: sampleProductsPayload });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const result = await client.storefront.products.list({ page: 1, pageSize: 20, sort: "newest" });

    expect(calls).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.data).toHaveLength(1);

    const product = result.data[0]!;
    expect(product.slug).toBe("kopi-arabika-gayo-200g");
    expect(product.createdAt).toBeInstanceOf(Date);

    const variant = product.variants[0]!;
    expect(typeof variant.price.amount).toBe("bigint");
    expect(variant.price.amount).toBe(95_000n);
    expect(variant.price.currency).toBe("IDR");
    expect(variant.compareAtPrice).toBeNull();
  });

  it("serializes filters into the query string", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { data: [], total: 0, page: 2, pageSize: 5 },
    });
    const client = createClient({ baseUrl: "http://localhost:8000/", fetch });

    await client.storefront.products.list({
      categorySlug: "kopi",
      search: "arabika",
      minPriceAmount: 50_000n,
      maxPriceAmount: 200_000n,
      page: 2,
      pageSize: 5,
      sort: "price_asc",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    // Trailing slash on baseUrl is normalized.
    expect(url.origin + url.pathname).toBe("http://localhost:8000/storefront/v1/products");
    expect(url.searchParams.get("categorySlug")).toBe("kopi");
    expect(url.searchParams.get("search")).toBe("arabika");
    expect(url.searchParams.get("minPriceAmount")).toBe("50000");
    expect(url.searchParams.get("maxPriceAmount")).toBe("200000");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("sort")).toBe("price_asc");
  });

  it("omits undefined query parameters", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { data: [], total: 0, page: 1, pageSize: 20 },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.products.list();

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.search).toBe("");
  });
});

describe("createClient — error handling", () => {
  it("throws ApiError with the server-supplied envelope fields", async () => {
    const { fetch } = mockFetch({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: "Product not found.",
          details: { slug: "missing" },
        },
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await expect(client.storefront.products.bySlug("missing")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      message: "Product not found.",
      status: 404,
      details: { slug: "missing" },
    });
  });

  it("falls back to http_error when no envelope is present", async () => {
    const { fetch } = mockFetch({ status: 500, body: { oops: true } });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    try {
      await client.storefront.categories.list();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("http_error");
      expect(apiErr.status).toBe(500);
    }
  });

  it("throws request_timeout when the built-in timeout fires", async () => {
    const { fetch } = mockFetch({ hang: true });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    try {
      await client.storefront.products.list(undefined, { timeoutMs: 25 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      // Either code is acceptable per the spec — we expect timeout in this
      // path because the caller did not provide a signal of their own.
      expect(["request_timeout", "request_aborted"]).toContain(apiErr.code);
      expect(apiErr.status).toBe(0);
    }
  });

  it("throws request_aborted when the caller's signal is already aborted", async () => {
    const { fetch } = mockFetch({ status: 200, body: { data: [], total: 0, page: 1, pageSize: 20 } });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.storefront.products.list(undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "request_aborted", status: 0 });
  });
});

describe("createClient — locale", () => {
  // Track A's API accepts `?locale=id|en` on storefront catalog routes.
  // The SDK's contract: send the locale when set, otherwise omit the param
  // entirely (the API falls back to Accept-Language). A per-call value
  // overrides the instance default; an instance default applies only when
  // the caller didn't specify one.
  const emptyList = { data: [], total: 0, page: 1, pageSize: 20 };

  it("omits the locale query param when neither default nor per-call is set", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: emptyList });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.products.list();

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has("locale")).toBe(false);
  });

  it("sends the per-call locale on products.list", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: emptyList });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.products.list({ locale: "en" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("locale")).toBe("en");
  });

  it("sends the per-call locale on products.bySlug", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        ...sampleProductsPayload.data[0],
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.products.bySlug("kopi-arabika-gayo-200g", { locale: "en" });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/storefront/v1/products/kopi-arabika-gayo-200g");
    expect(url.searchParams.get("locale")).toBe("en");
  });

  it("sends the per-call locale on categories.list", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { data: [] } });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.categories.list({ locale: "en" });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("locale")).toBe("en");
  });

  it("uses the instance-default locale when no per-call locale is passed", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: emptyList });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch, locale: "en" });

    await client.storefront.products.list();
    await client.storefront.categories.list();

    expect(new URL(calls[0]!.url).searchParams.get("locale")).toBe("en");
    expect(new URL(calls[1]!.url).searchParams.get("locale")).toBe("en");
  });

  it("per-call locale overrides the instance default", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: emptyList });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch, locale: "id" });

    await client.storefront.products.list({ locale: "en" });

    expect(new URL(calls[0]!.url).searchParams.get("locale")).toBe("en");
  });

  it("forwards the instance default to bySlug when no per-call locale is set", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ...sampleProductsPayload.data[0] },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch, locale: "id" });

    await client.storefront.products.bySlug("kopi-arabika-gayo-200g");

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("locale")).toBe("id");
  });
});

describe("createClient — storefront.cart", () => {
  // A minimally complete WireCart payload reused across cart tests. Money
  // values arrive as decimal strings on the wire and must surface as bigints
  // on the domain side; the assertions below pin that boundary.
  const sampleCartPayload = {
    id: "cart_01J",
    customerId: null,
    currency: "IDR",
    status: "active",
    items: [
      {
        id: "ci_01",
        cartId: "cart_01J",
        variantId: "var_abc",
        quantity: 2,
        unitPrice: { amount: "95000", currency: "IDR" },
        lineTotal: { amount: "190000", currency: "IDR" },
        createdAt: "2026-05-01T08:00:00.000Z",
        updatedAt: "2026-05-01T08:00:00.000Z",
      },
    ],
    totals: {
      subtotal: { amount: "190000", currency: "IDR" },
      tax: { amount: "0", currency: "IDR" },
      shipping: { amount: "0", currency: "IDR" },
      total: { amount: "190000", currency: "IDR" },
    },
    expiresAt: "2026-06-01T08:00:00.000Z",
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-01T08:00:00.000Z",
  };

  it("creates a guest cart and POSTs the currency body", async () => {
    const { fetch, calls } = mockFetch({ status: 201, body: { ...sampleCartPayload, items: [], totals: sampleCartPayload.totals } });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const cart = await client.storefront.cart.create({ currency: "IDR" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:8000/storefront/v1/carts");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ currency: "IDR" }));
    expect(cart.id).toBe("cart_01J");
    expect(cart.currency).toBe("IDR");
    expect(cart.expiresAt).toBeInstanceOf(Date);
  });

  it("addItem returns a cart with bigint Money on items and totals", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: sampleCartPayload });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const cart = await client.storefront.cart.addItem("cart_01J", {
      variantId: "var_abc",
      quantity: 2,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/storefront/v1/carts/cart_01J/items");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ variantId: "var_abc", quantity: 2 }),
    );

    expect(cart.items).toHaveLength(1);
    const item = cart.items[0]!;
    expect(typeof item.unitPrice.amount).toBe("bigint");
    expect(item.unitPrice.amount).toBe(95_000n);
    expect(typeof item.lineTotal.amount).toBe("bigint");
    expect(item.lineTotal.amount).toBe(190_000n);
    expect(typeof cart.totals.subtotal.amount).toBe("bigint");
    expect(cart.totals.subtotal.amount).toBe(190_000n);
    expect(cart.totals.total.amount).toBe(190_000n);
  });

  it("surfaces validation_error envelope when variantId is invalid", async () => {
    const { fetch } = mockFetch({
      status: 422,
      body: {
        error: {
          code: "validation_error",
          message: "Request validation failed.",
          details: { variantId: "Required" },
        },
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await expect(
      client.storefront.cart.addItem("cart_01J", {
        variantId: "",
        quantity: 1,
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "validation_error",
      status: 422,
      details: { variantId: "Required" },
    });
  });

  it("URL-encodes ids on updateItem, removeItem, and clear", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: sampleCartPayload });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.cart.updateItem("cart 01", "ci/01", { quantity: 3 });
    await client.storefront.cart.removeItem("cart 01", "ci/01");
    await client.storefront.cart.clear("cart 01");

    expect(calls).toHaveLength(3);
    const update = new URL(calls[0]!.url);
    expect(update.pathname).toBe("/storefront/v1/carts/cart%2001/items/ci%2F01");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ quantity: 3 }));

    const remove = new URL(calls[1]!.url);
    expect(remove.pathname).toBe("/storefront/v1/carts/cart%2001/items/ci%2F01");
    expect(calls[1]!.init?.method).toBe("DELETE");

    const clear = new URL(calls[2]!.url);
    expect(clear.pathname).toBe("/storefront/v1/carts/cart%2001/clear");
    expect(calls[2]!.init?.method).toBe("POST");
  });
});

describe("createClient — regions", () => {
  it("lists provinces and returns plain shapes", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { data: [{ id: "31", name: "DKI Jakarta" }] },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const provinces = await client.storefront.regions.provinsi();
    expect(provinces).toEqual([{ id: "31", name: "DKI Jakarta" }]);
    expect(calls[0]!.url).toBe("http://localhost:8000/storefront/v1/regions/provinsi");
  });

  it("passes provinsiId through to the kota-kabupaten endpoint", async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { data: [] } });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.storefront.regions.kotaKabupaten({ provinsiId: "31" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/storefront/v1/regions/kota-kabupaten");
    expect(url.searchParams.get("provinsiId")).toBe("31");
  });
});

// ----------------------------------------------------------------------------
// Admin product mutations
//
// These tests pin four properties that matter for the admin product editor:
//
//   1. Happy path — the create body lands at the right URL with the right
//      method and the wire response round-trips back to a domain `Product`.
//   2. Conflict envelope — a 409 with the standard `{error:{code,message}}`
//      shape surfaces as an `ApiError` whose `code` matches the server, so
//      the editor can branch on it without parsing strings.
//   3. Locale forwarding — the PATCH body stays clean (instance-default
//      locale rides on reads, not writes) and `credentials: include` flips
//      on so the session cookie travels.
//   4. Bigint serialization — `JSON.stringify` would throw on a `bigint`,
//      so the SDK must convert variant prices to decimal-integer strings at
//      the boundary while keeping `bigint` on the domain side.
// ----------------------------------------------------------------------------

const sampleVariantWirePayload = {
  id: "var_new",
  productId: "prod_abc",
  sku: "GAYO-200-WHOLE",
  title: "Biji utuh",
  price: { amount: "95000", currency: "IDR" },
  compareAtPrice: null,
  createdAt: "2026-04-12T08:00:00.000Z",
  updatedAt: "2026-04-12T08:00:00.000Z",
  deletedAt: null,
};

const sampleProductWirePayload = {
  id: "prod_abc",
  slug: "kopi-arabika-gayo-200g",
  title: "Kopi Arabika Gayo 200g",
  description: "Kopi arabika dari Gayo.",
  status: "draft",
  defaultCurrency: "IDR",
  imageUrl: null,
  imageAlt: null,
  categoryIds: [],
  variants: [],
  createdAt: "2026-04-12T08:00:00.000Z",
  updatedAt: "2026-04-12T08:00:00.000Z",
  deletedAt: null,
};

describe("createClient — admin.products mutations", () => {
  it("posts the create body and round-trips the response to a domain Product", async () => {
    const { fetch, calls } = mockFetch({
      status: 201,
      body: sampleProductWirePayload,
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const product = await client.admin.products.create({
      slug: "kopi-arabika-gayo-200g",
      defaultCurrency: "IDR",
      translations: {
        id: { title: "Kopi Arabika Gayo 200g", description: "Kopi arabika." },
        en: { title: "Gayo Arabica Coffee 200g" },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:8000/admin/v1/products");
    expect(calls[0]!.init?.method).toBe("POST");
    // Cookie must travel on the admin namespace.
    expect(calls[0]!.init?.credentials).toBe("include");

    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({
      slug: "kopi-arabika-gayo-200g",
      defaultCurrency: "IDR",
      translations: {
        id: { title: "Kopi Arabika Gayo 200g", description: "Kopi arabika." },
        en: { title: "Gayo Arabica Coffee 200g" },
      },
    });
    expect(product.slug).toBe("kopi-arabika-gayo-200g");
    expect(product.createdAt).toBeInstanceOf(Date);
  });

  it("surfaces the conflict envelope as an ApiError with the server code", async () => {
    const { fetch } = mockFetch({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "A product with that slug already exists.",
          details: { field: "slug" },
        },
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await expect(
      client.admin.products.create({
        slug: "kopi-arabika-gayo-200g",
        defaultCurrency: "IDR",
        translations: { id: { title: "Kopi" } },
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "conflict",
      status: 409,
      details: { field: "slug" },
    });
  });

  it("issues a clean PATCH body with credentials on update", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: sampleProductWirePayload,
    });
    const client = createClient({
      baseUrl: "http://localhost:8000",
      fetch,
      // Admin writes do not currently send `?locale=` per call. The instance
      // default still rides on read calls (list/byId); a future change to
      // forward it on writes would be a deliberate decision and break this
      // test. Pinning the current behavior keeps that decision visible.
      locale: "id",
    });

    await client.admin.products.update("prod_abc", { status: "active" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:8000/admin/v1/products/prod_abc",
    );
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(calls[0]!.init?.credentials).toBe("include");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({ status: "active" });
  });

  it("serializes bigint variant prices to decimal strings on the wire", async () => {
    const { fetch, calls } = mockFetch({
      status: 201,
      body: sampleVariantWirePayload,
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const variant = await client.admin.products.createVariant("prod_abc", {
      sku: "GAYO-200-WHOLE",
      priceAmount: 95_000n,
      compareAtAmount: 120_000n,
      translations: { id: { title: "Biji utuh" } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:8000/admin/v1/products/prod_abc/variants",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    // The wire form is decimal-integer strings — JSON.stringify on a bigint
    // would otherwise throw. This is the load-bearing property.
    expect(sentBody.priceAmount).toBe("95000");
    expect(sentBody.compareAtAmount).toBe("120000");
    expect(typeof sentBody.priceAmount).toBe("string");
    // The response decode still produces a `bigint` on the domain side.
    expect(typeof variant.price.amount).toBe("bigint");
    expect(variant.price.amount).toBe(95_000n);
  });

  it("issues a DELETE for soft-delete", async () => {
    // The mock returns 200 with an empty body (the `Response` constructor
    // refuses a 204 + body in some runtimes). The behavior we care about is
    // the URL, method, and that the SDK does not throw on an empty success.
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.admin.products.delete("prod_abc");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:8000/admin/v1/products/prod_abc",
    );
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

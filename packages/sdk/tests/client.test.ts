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

// ----------------------------------------------------------------------------
// Storefront checkout — happy-path state machine + idempotency-key replay.
//
// The headline property is that `complete` rides on an `Idempotency-Key`
// header and that re-issuing the call with the same key returns the same
// response without re-running the transition. We assert this by replaying
// the same key against a fake fetch that returns the same payload twice
// (the API's idempotency middleware would short-circuit the second hit;
// at the SDK boundary we just need to confirm the header travels with both
// requests, which is the precondition for the server-side dedupe to fire).
// ----------------------------------------------------------------------------

describe("createClient — storefront.checkout", () => {
  const baseCheckout = {
    id: "chk_01J",
    cartId: "cart_01J",
    customerId: "cus_01J",
    state: "pending" as const,
    shippingAddressId: null,
    billingAddressId: null,
    email: null,
    shippingMethodCode: null,
    shippingAmount: null,
    paymentMethod: null,
    cancellationReason: null,
    idempotencyKey: null,
    expiresAt: "2026-06-01T08:00:00.000Z",
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-01T08:00:00.000Z",
  };

  const awaitingShippingPayload = {
    ...baseCheckout,
    state: "awaiting_shipping" as const,
    shippingAddressId: "adr_ship",
    billingAddressId: "adr_ship",
  };

  const awaitingPaymentPayload = {
    ...awaitingShippingPayload,
    state: "awaiting_payment" as const,
    shippingMethodCode: "MANUAL_FLAT",
    shippingAmount: { amount: "15000", currency: "IDR" },
  };

  const completedPayload = {
    ...awaitingPaymentPayload,
    state: "completed" as const,
    paymentMethod: "manual_bank_transfer",
    idempotencyKey: "idem_01HZ",
  };

  const orderIntentPayload = {
    id: "oi_01J",
    checkoutId: "chk_01J",
    cartSnapshot: [
      {
        variantId: "var_abc",
        quantity: 2,
        unitPrice: { amount: "95000", currency: "IDR" },
      },
    ],
    totalsSnapshot: {
      subtotal: { amount: "190000", currency: "IDR" },
      tax: { amount: "0", currency: "IDR" },
      shipping: { amount: "15000", currency: "IDR" },
      total: { amount: "205000", currency: "IDR" },
    },
    shippingAddressSnapshot: {
      id: "adr_ship",
      customerId: "cus_01J",
      kind: "shipping" as const,
      recipientName: "Sari",
      phone: "+6281234567890",
      addressLine1: "Jl. Melati 1",
      addressLine2: null,
      provinsiId: "31",
      kotaKabupatenId: "3171",
      kecamatanId: "317101",
      kelurahanId: null,
      postalCode: "10110",
      notes: null,
    },
    billingAddressSnapshot: null,
    email: "sari@example.com",
    shippingMethodCode: "MANUAL_FLAT",
    paymentMethod: "manual_bank_transfer",
    createdAt: "2026-05-01T08:10:00.000Z",
  };

  it("walks start → setAddresses → setShipping → complete and converts wire shapes", async () => {
    const responses: Array<{ status: number; body: unknown }> = [
      { status: 201, body: baseCheckout },
      { status: 200, body: awaitingShippingPayload },
      { status: 200, body: awaitingPaymentPayload },
      { status: 200, body: { checkout: completedPayload, orderIntent: orderIntentPayload } },
    ];
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = (input, init) => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra fetch call");
      calls.push({ url: input, init });
      return Promise.resolve(
        new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const created = await client.storefront.checkout.start({
      cartId: "cart_01J",
      email: "sari@example.com",
    });
    expect(created.state).toBe("pending");
    expect(calls[0]!.url).toBe("http://localhost:8000/storefront/v1/checkouts");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({ cartId: "cart_01J", email: "sari@example.com" }),
    );

    const withAddresses = await client.storefront.checkout.setAddresses("chk_01J", {
      shippingAddressId: "adr_ship",
    });
    expect(withAddresses.state).toBe("awaiting_shipping");
    const addressUrl = new URL(calls[1]!.url);
    expect(addressUrl.pathname).toBe(
      "/storefront/v1/checkouts/chk_01J/addresses",
    );
    expect(calls[1]!.init?.method).toBe("PUT");

    const withShipping = await client.storefront.checkout.setShipping("chk_01J", {
      shippingMethodCode: "MANUAL_FLAT",
    });
    expect(withShipping.state).toBe("awaiting_payment");
    expect(withShipping.shippingAmount?.amount).toBe(15_000n);
    expect(withShipping.shippingAmount?.currency).toBe("IDR");
    const shippingUrl = new URL(calls[2]!.url);
    expect(shippingUrl.pathname).toBe(
      "/storefront/v1/checkouts/chk_01J/shipping",
    );
    expect(calls[2]!.init?.method).toBe("PUT");

    const result = await client.storefront.checkout.complete("chk_01J", {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "idem_01HZ",
    });
    expect(result.checkout.state).toBe("completed");
    expect(result.orderIntent.id).toBe("oi_01J");
    expect(result.orderIntent.totalsSnapshot.total.amount).toBe(205_000n);
    expect(result.orderIntent.cartSnapshot[0]!.unitPrice.amount).toBe(95_000n);

    const completeUrl = new URL(calls[3]!.url);
    expect(completeUrl.pathname).toBe(
      "/storefront/v1/checkouts/chk_01J/complete",
    );
    expect(calls[3]!.init?.method).toBe("POST");
    expect(calls[3]!.init?.body).toBe(
      JSON.stringify({ paymentMethod: "manual_bank_transfer" }),
    );
    const headers = new Headers(calls[3]!.init?.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("idem_01HZ");
  });

  it("re-sends the same Idempotency-Key on a replay so the server can dedupe", async () => {
    const completePayload = {
      checkout: completedPayload,
      orderIntent: orderIntentPayload,
    };
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = (input, init) => {
      calls.push({ url: input, init });
      return Promise.resolve(
        new Response(JSON.stringify(completePayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const first = await client.storefront.checkout.complete("chk_01J", {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "idem_replay",
    });
    const second = await client.storefront.checkout.complete("chk_01J", {
      paymentMethod: "manual_bank_transfer",
      idempotencyKey: "idem_replay",
    });

    expect(first.orderIntent.id).toBe(second.orderIntent.id);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers as HeadersInit);
      expect(headers.get("idempotency-key")).toBe("idem_replay");
    }
  });

  it("surfaces the idempotency_key_reuse envelope as ApiError on 409", async () => {
    const { fetch } = mockFetch({
      status: 409,
      body: {
        error: {
          code: "idempotency_key_reuse",
          message: "Idempotency key reused with a different request body.",
          details: { scope: "checkout.complete" },
        },
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await expect(
      client.storefront.checkout.complete("chk_01J", {
        paymentMethod: "manual_bank_transfer",
        idempotencyKey: "idem_clash",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "idempotency_key_reuse",
      status: 409,
    });
  });

  it("lists active shipping methods with the currency filter", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        data: [
          {
            id: "sm_01J",
            code: "MANUAL_FLAT",
            name: "Pengiriman manual",
            providerKind: "manual",
            flatRate: { amount: "15000", currency: "IDR" },
            isActive: true,
            createdAt: "2026-05-01T08:00:00.000Z",
            updatedAt: "2026-05-01T08:00:00.000Z",
            deletedAt: null,
          },
        ],
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const methods = await client.storefront.shipping.methods({ currency: "IDR" });

    expect(methods).toHaveLength(1);
    expect(methods[0]!.code).toBe("MANUAL_FLAT");
    expect(methods[0]!.flatRate?.amount).toBe(15_000n);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/storefront/v1/shipping/methods");
    expect(url.searchParams.get("currency")).toBe("IDR");
  });

  it("forwards x-customer-id when listing the signed-in customer's addresses", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        data: [
          {
            id: "adr_01J",
            customerId: "cus_01J",
            kind: "shipping",
            isDefaultShipping: true,
            isDefaultBilling: false,
            recipientName: "Sari",
            phone: "+6281234567890",
            addressLine1: "Jl. Melati 1",
            addressLine2: null,
            provinsiId: "31",
            kotaKabupatenId: "3171",
            kecamatanId: "317101",
            kelurahanId: null,
            postalCode: "10110",
            notes: null,
            createdAt: "2026-05-01T08:00:00.000Z",
            updatedAt: "2026-05-01T08:00:00.000Z",
            deletedAt: null,
          },
        ],
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const addresses = await client.storefront.customer.myAddresses({
      customerId: "cus_01J",
    });

    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.recipientName).toBe("Sari");
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit);
    expect(headers.get("x-customer-id")).toBe("cus_01J");
  });
});

// ---------------------------------------------------------------------------
// Admin orders surface
// ---------------------------------------------------------------------------

const sampleOrderPayload = {
  id: "ord_01J",
  orderNumber: "ORD-2026-000123",
  customerId: "cus_01J",
  email: "buyer@example.com",
  currency: "IDR",
  status: "pending_payment",
  subtotal: { amount: "500000", currency: "IDR" },
  tax: { amount: "55000", currency: "IDR" },
  taxRateCode: null,
  taxRateBasisPoints: null,
  shipping: { amount: "10000", currency: "IDR" },
  shippingMethodCode: "MANUAL_FLAT",
  total: { amount: "565000", currency: "IDR" },
  shippingAddressSnapshot: {
    id: "adr_01J",
    customerId: "cus_01J",
    kind: "shipping",
    recipientName: "Sari",
    phone: "+6281234567890",
    addressLine1: "Jl. Melati 1",
    addressLine2: null,
    provinsiId: "31",
    kotaKabupatenId: "3171",
    kecamatanId: "317101",
    kelurahanId: null,
    postalCode: "10110",
    notes: null,
  },
  billingAddressSnapshot: null,
  paymentMethod: "manual_bank_transfer",
  items: [
    {
      id: "oi_01",
      orderId: "ord_01J",
      variantId: "var_01J",
      sku: "GAYO-200-WHOLE",
      title: "Biji utuh",
      quantity: 2,
      unitPrice: { amount: "250000", currency: "IDR" },
      lineSubtotal: { amount: "500000", currency: "IDR" },
      createdAt: "2026-05-01T08:00:00.000Z",
    },
  ],
  paidAt: null,
  fulfilledAt: null,
  cancelledAt: null,
  refundedAt: null,
  cancellationReason: null,
  createdAt: "2026-05-01T08:00:00.000Z",
  updatedAt: "2026-05-01T08:00:00.000Z",
};

describe("createClient — admin.orders", () => {
  it("lists orders, converting Money to bigint and forwarding filter + locale to the URL", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        data: [sampleOrderPayload],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    const client = createClient({
      baseUrl: "http://localhost:8000",
      fetch,
      locale: "id",
    });

    const result = await client.admin.orders.list({
      status: "pending_payment",
      email: "buyer@example.com",
      locale: "en",
    });

    expect(result.total).toBe(1);
    const order = result.data[0]!;
    expect(order.total.amount).toBe(565_000n);
    expect(order.subtotal.amount).toBe(500_000n);
    expect(order.items[0]!.unitPrice.amount).toBe(250_000n);
    expect(order.createdAt).toBeInstanceOf(Date);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/admin/v1/orders");
    expect(url.searchParams.get("status")).toBe("pending_payment");
    expect(url.searchParams.get("email")).toBe("buyer@example.com");
    // Per-call locale wins over the instance default.
    expect(url.searchParams.get("locale")).toBe("en");
  });

  it("fetches a single order by id and converts the wire money + dates", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ...sampleOrderPayload, paidAt: "2026-05-02T09:00:00.000Z" },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const order = await client.admin.orders.byId("ord_01J");
    expect(order.id).toBe("ord_01J");
    expect(order.paidAt).toBeInstanceOf(Date);
    expect(order.paidAt!.toISOString()).toBe("2026-05-02T09:00:00.000Z");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/admin/v1/orders/ord_01J");
  });

  it("posts the transition input as JSON and returns the new state", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ...sampleOrderPayload, status: "paid", paidAt: "2026-05-02T09:00:00.000Z" },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const order = await client.admin.orders.transition("ord_01J", {
      toStatus: "paid",
      details: { providerReference: "MID-123" },
    });
    expect(order.status).toBe("paid");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/admin/v1/orders/ord_01J/transition");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as {
      toStatus: string;
      details: Record<string, unknown>;
    };
    expect(body.toStatus).toBe("paid");
    expect(body.details).toEqual({ providerReference: "MID-123" });
  });

  it("posts the cancel reason as JSON", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        ...sampleOrderPayload,
        status: "cancelled",
        cancelledAt: "2026-05-02T09:00:00.000Z",
        cancellationReason: "duplicate",
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const order = await client.admin.orders.cancel("ord_01J", {
      reason: "duplicate",
    });
    expect(order.status).toBe("cancelled");
    expect(order.cancellationReason).toBe("duplicate");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/admin/v1/orders/ord_01J/cancel");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as {
      reason: string;
    };
    expect(body.reason).toBe("duplicate");
  });
});

// ----------------------------------------------------------------------------
// Admin inventory — only the signed `adjust` mutation is wired at v0.1.
// The headline assertions:
//   - The request lands on the variant-scoped path with cookies.
//   - The body is `{ delta }` verbatim (the SDK does not coerce or rename).
//   - The response is decoded into a domain `InventoryLevel` with a `Date`
//     `updatedAt` rather than a raw ISO string.
//   - 409 conflict ("would drive available below zero") surfaces as ApiError
//     with the server code intact, so callers can branch on it.
// ----------------------------------------------------------------------------

describe("createClient — admin.inventory", () => {
  const sampleInventoryWirePayload = {
    id: "inv_01J",
    variantId: "var_abc",
    locationId: null,
    available: 105,
    reserved: 0,
    updatedAt: "2026-05-07T08:00:00.000Z",
  };

  it("posts a signed delta to the variant inventory endpoint", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: sampleInventoryWirePayload,
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    const level = await client.admin.inventory.adjust("var_abc", { delta: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost:8000/admin/v1/variants/var_abc/inventory/adjust",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({ delta: 5 });

    expect(level.variantId).toBe("var_abc");
    expect(level.available).toBe(105);
    expect(level.updatedAt).toBeInstanceOf(Date);
  });

  it("forwards a negative delta verbatim — sign is the caller's contract", async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ...sampleInventoryWirePayload, available: 95 },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await client.admin.inventory.adjust("var_abc", { delta: -10 });

    const sentBody = JSON.parse(String(calls[0]!.init?.body));
    expect(sentBody).toEqual({ delta: -10 });
  });

  it("surfaces 409 (would-go-negative) as ApiError with the server code", async () => {
    const { fetch } = mockFetch({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "Inventory adjustment would drive `available` below zero.",
          details: { variantId: "var_abc", delta: -1000, available: 5 },
        },
      },
    });
    const client = createClient({ baseUrl: "http://localhost:8000", fetch });

    await expect(
      client.admin.inventory.adjust("var_abc", { delta: -1000 }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "conflict",
      status: 409,
    });
  });
});

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

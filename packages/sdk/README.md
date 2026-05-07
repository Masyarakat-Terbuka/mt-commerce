# @mt-commerce/sdk

Typed HTTP client for the mt-commerce API. Used by the reference storefront
and admin, and shipped for anyone building a custom client.

## Install

```sh
# Inside the monorepo, declare the workspace dependency.
{
  "dependencies": {
    "@mt-commerce/sdk": "workspace:*"
  }
}
```

The package has zero runtime dependencies beyond `@mt-commerce/core`. It uses
the platform `fetch`, so the same client runs in Bun, Node 18+, the browser,
and any Workers-style runtime.

## Usage

```ts
import { createClient } from "@mt-commerce/sdk";

const client = createClient({ baseUrl: "http://localhost:8000" });

const page = await client.storefront.products.list({
  page: 1,
  pageSize: 20,
  sort: "newest",
});

const product = await client.storefront.products.bySlug(
  "kopi-arabika-gayo-200g",
);

const categories = await client.storefront.categories.list();
const provinces = await client.storefront.regions.provinsi();
const cities = await client.storefront.regions.kotaKabupaten({ provinsiId: "31" });
```

### Money on the wire

The API serializes `Money` as `{ amount: string; currency: string }` per
[ADR-0007](../../docs/adr/0007-money-as-integers.md). The SDK converts the
string form to a `bigint` via `Money.fromJSON` before handing it to the
caller — consumers always receive the `Money` type from `@mt-commerce/core`.

### Errors

Every failure surfaces as a single `ApiError` with a stable `code`:

```ts
import { ApiError } from "@mt-commerce/sdk";

try {
  await client.storefront.products.bySlug("missing");
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.code, err.status, err.details);
  }
}
```

Codes used by the v0.1 client:

| `code`             | When                                                           |
| ------------------ | -------------------------------------------------------------- |
| `request_aborted`  | Caller's `AbortSignal` aborted the request                     |
| `request_timeout`  | Built-in timeout (default 5s) fired                            |
| `network_error`    | `fetch` threw before a response was received                   |
| `decode_error`     | Server returned an unparseable body                            |
| `http_error`       | Non-2xx without the standard error envelope                    |
| any server code    | Server returned a `{ error: { code, message, details } }` body |

### Per-call options

```ts
await client.storefront.products.list({ page: 1 }, {
  timeoutMs: 10_000,        // override the 5s default; 0 disables the timeout
  signal: controller.signal, // composed with the timeout signal
});
```

### Client options

```ts
createClient({
  baseUrl: "http://localhost:8000",
  fetch: customFetch,        // optional; defaults to globalThis.fetch
  defaultTimeoutMs: 8_000,   // optional; defaults to 5000
});
```

## Scripts

```sh
bun run typecheck   # tsc --noEmit
bun run build       # tsc -p tsconfig.build.json (emits dist/ with .d.ts)
bun run test        # vitest run
bun run lint        # eslint .
```

## Status

This is the v0.1 surface — it covers the storefront read endpoints the
reference storefront consumes. Cart, checkout, and admin endpoints will be
added in future waves. The hand-written types in `src/types.ts` will be
replaced by an OpenAPI-generated set once the API's per-route annotations
ship.

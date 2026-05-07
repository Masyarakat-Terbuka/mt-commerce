# @mt-commerce/storefront

The reference storefront for mt-commerce. Astro for content pages, React for interactive islands.

## Stack

- Astro 5 (static output)
- React 19 islands via `@astrojs/react`
- Tailwind CSS v4 via `@tailwindcss/vite`
- `@mt-commerce/sdk` for typed API access
- Vitest for unit tests
- Bahasa Indonesia is the default locale; English is available at `/en/...`

The architecture rationale lives in [ADR-0006](../../docs/adr/0006-astro-storefront.md).

## Develop

From the repository root:

```bash
bun install
cp apps/storefront/.env.example apps/storefront/.env
bun --filter '@mt-commerce/storefront' dev
```

The dev server runs at `http://localhost:4321`. Indonesian routes are at `/`, English at `/en/`.

## Configuration

`PUBLIC_API_URL` — base URL of the mt-commerce API. Default if unset:
`http://localhost:8000`. Astro inlines `PUBLIC_*` env vars at build time so
the same URL is used by build-time SDK calls and the React islands that
re-fetch in the browser. See [`.env.example`](./.env.example).

## Build

```bash
bun --filter '@mt-commerce/storefront' build
```

Output is written to `dist/` as static files.

## Test and check

```bash
bun --filter '@mt-commerce/storefront' typecheck
bun --filter '@mt-commerce/storefront' test
bun --filter '@mt-commerce/storefront' lint
```

## Data: SDK with progressive hydration

The storefront talks to the API through `@mt-commerce/sdk`. Because the
storefront builds with `output: "static"` and the API may not be running at
build time (offline CI, fresh clone, demo mode), the data layer is
deliberately optimistic:

| Where                        | What happens                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `lib/api.ts` (build time)    | Each SDK call is wrapped in try/catch; on failure logs to console and returns `[]` / `null`. The build never crashes. |
| Listing pages                | Render a "Memuat produk…" placeholder. The `<ProductGrid client:load />` island fetches from the SDK on mount.        |
| Detail pages (`[slug]`)      | `getStaticPaths` enumerates slugs via the SDK at build time. If the API is unreachable, no detail pages are emitted.  |
| Detail page body             | Renders a placeholder; `<ProductDetail client:load />` re-fetches by slug on mount so visitors see fresh data.        |

**Trade-off (option C from the design discussion):** the static build is
deterministic and offline-friendly, at the cost of an initial loading state
in the browser. We considered (a) full build-time fetch with cache and (b)
SSR/hybrid output, and rejected both for v0.1: (a) breaks offline builds,
(b) adds a Node runtime dependency to deploys. We can revisit when CDN
coverage and an online build environment are universal.

The empty-state, loading, and error strings are translated through
`src/i18n/{id,en}.json` — Bahasa Indonesia is the source of truth.

### Testing against a live API

```bash
# Terminal 1
docker compose up postgres redis
bun --filter '@mt-commerce/api' dev          # runs on :8000 by default

# Terminal 2
PUBLIC_API_URL=http://localhost:8000 bun --filter '@mt-commerce/storefront' dev
```

### Testing offline

Just run the dev or build commands without an API. You will see resilience
diagnostics on the build console and "Memuat produk…" placeholders in the
browser. This is the intended fallback.

## Layout

```
src/
  components/   # Astro components, server-rendered, no JS shipped
  islands/      # React components hydrated as islands
  layouts/      # Page shell
  lib/          # api wrapper, mock data (deprecated), i18n helper
  i18n/         # id.json, en.json
  pages/        # File-based routes
  styles/       # global.css (Tailwind entry)
tests/          # Vitest unit tests
```

## What is coming next

- Cart state and the cart drawer (replacing the placeholder island)
- Checkout flow
- Customer accounts and order history

These are tracked separately and are not part of this scaffold.

## Notes

- Money is `{ amount: bigint; currency: string }`. Formatting goes through `@mt-commerce/core/money`.
- The legacy `src/lib/mock-products.ts` module is retained only for the
  current unit test fixture and is marked `@deprecated`. Pages, components,
  and islands import only from `src/lib/api.ts`.
- Variant selector and add-to-cart islands talk to each other via a
  `variant-change` `CustomEvent` on `document`. This is a temporary bridge
  until a shared cart store lands.

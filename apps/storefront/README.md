# @mt-commerce/storefront

The reference storefront for mt-commerce. Astro for content pages, React for interactive islands.

## Stack

- Astro 5 (static output)
- React 19 islands via `@astrojs/react`
- Tailwind CSS v4 via `@tailwindcss/vite`
- Vitest for unit tests
- Bahasa Indonesia is the default locale; English is available at `/en/...`

The architecture rationale lives in [ADR-0006](../../docs/adr/0006-astro-storefront.md).

## Develop

From the repository root:

```bash
bun install
bun --filter '@mt-commerce/storefront' dev
```

The dev server runs at `http://localhost:4321`. Indonesian routes are at `/`, English at `/en/`.

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

## What is mocked

The storefront does not yet talk to the API. The product catalog is served from `src/lib/mock-products.ts` through `src/lib/api.ts`. When `@mt-commerce/sdk` ships, `src/lib/api.ts` is the only file that needs to be rewired to use it.

## What is coming next

- SDK integration for the catalog (`@mt-commerce/sdk`, see ADR-0008)
- Cart state and the cart drawer (replacing the placeholder island)
- Checkout flow
- Customer accounts and order history

These are tracked separately and are not part of this scaffold.

## Layout

```
src/
  components/   # Astro components, server-rendered, no JS shipped
  islands/      # React components hydrated as islands
  layouts/      # Page shell
  lib/          # api wrapper, mock data, i18n helper
  i18n/         # id.json, en.json
  pages/        # File-based routes
  styles/       # global.css (Tailwind entry)
tests/          # Vitest unit tests
```

## Notes

- Money is `{ amount: bigint; currency: string }`. Formatting goes through `@mt-commerce/core/money`.
- Variant selector and add-to-cart islands talk to each other via a `variant-change` `CustomEvent` on `document`. This is a temporary bridge until a shared cart store lands.

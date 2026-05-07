# @mt-commerce/core

Shared types and utilities for mt-commerce. Pure TypeScript, no runtime
side effects, used by every other workspace.

## Exports

```ts
// Everything (re-exported from the subpaths below)
import { add, id, CoreError } from "@mt-commerce/core";

// Subpath imports — minimize what you pull in
import { add, format, type Money } from "@mt-commerce/core/money";
import { id, rawUlid } from "@mt-commerce/core/ulid";
import { CoreError, CurrencyMismatchError } from "@mt-commerce/core/errors";
```

## What lives here

- **`money`** — the `Money` value object and its helpers (`add`,
  `subtract`, `multiply`, `format`, `toJSON`, `fromJSON`, …).
  Implements [ADR-0007: Money as integers](../../docs/adr/0007-money-as-integers.md).
- **`ulid`** — `id(prefix)` and `rawUlid()` for generating typed,
  prefixed application IDs.
- **`errors`** — `CoreError` and `CurrencyMismatchError`, the error
  shape thrown by core helpers.

## Money in one paragraph

Amounts are `bigint` in the smallest unit of the currency
(whole rupiah for IDR, cents for USD/EUR, etc.). Cross-currency
arithmetic throws `CurrencyMismatchError`. Multiplication by a fractional
number factor uses banker's rounding by default — pass
`{ rounding: "halfUp" }` or `{ rounding: "down" }` to override. JSON
serialization renders the bigint as a decimal string so values survive
`JSON.stringify` without precision loss.

## Scripts

```sh
bun run typecheck   # tsc --noEmit
bun run build       # tsc -p tsconfig.build.json (emits dist/ with .d.ts)
bun run test        # vitest run
bun run lint        # eslint .
```

In dev, consumers (`apps/api`, `apps/storefront`) read the package
straight from `src/` via the `exports` map — `bun run build` is only
needed for downstream packages that consume compiled `.d.ts`.

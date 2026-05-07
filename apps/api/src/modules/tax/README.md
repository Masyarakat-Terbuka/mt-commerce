# Tax module

Stores and applies tax rates. Indonesian PPN (Pajak Pertambahan Nilai) is
the v0.1 use case: a single global default rate per currency, applied to
the cart subtotal at totals-compute time.

## Storage

`tax_rates` (one row per code):

- `code` (UNIQUE) — operator-facing identifier, e.g. `PPN_11`.
- `rate_basis_points` (integer) — `1100` means 11.00%. Basis points keep
  the rate exact at integer level; no float hazards on the wire.
- `currency` — ISO 4217. Tax rates are currency-scoped because a 5% USD
  sales tax and an 11% IDR PPN are different things.
- `is_default` (boolean) — partial unique index on
  `(currency) WHERE is_default = true AND archived_at IS NULL` enforces
  "at most one default per currency".
- `archived_at` (nullable) — soft-delete-ish marker. Archived rows stay
  readable for audit but never satisfy `getDefaultRate`.

## Service surface

`TaxService` (constructor takes a repository so tests can inject a fake):

| method | purpose |
| --- | --- |
| `listRates({ activeOnly })` | admin listing |
| `getRateById(id)` | admin detail |
| `getRateByCode(code)` | lookups by stable code |
| `getDefaultRate(currency)` | cart-totals hot path; returns `null` if none |
| `createRate(input)` | admin create. Atomic clear-then-set when `isDefault: true`. |
| `updateRate(id, patch)` | admin update. Atomic clear-then-set when flipping `isDefault: true`. |
| `archiveRate(id)` | admin archive. Also clears `is_default`. |
| `applyTax(amount, rate)` | pure helper. `amount * (basisPoints / 10000)` with halfEven rounding. |

## Routes

- `GET /admin/v1/tax/rates`
- `POST /admin/v1/tax/rates`
- `GET /admin/v1/tax/rates/:id`
- `PATCH /admin/v1/tax/rates/:id`
- `POST /admin/v1/tax/rates/:id/set-default`
- `DELETE /admin/v1/tax/rates/:id` — archives
- `GET /storefront/v1/tax/rate?currency=IDR` — public; 404 when no
  default is configured

Admin routes are gated by `requireAuth` + `requireRole("owner",
"admin", "staff")`.

## Cart integration

The cart's `getTotals` calls `taxService.getDefaultRate(cart.currency)`
at compute time. When a rate is configured, the totals carry the applied
rate's code and basis points so the storefront can render "PPN 11%".
When no rate is configured (e.g. test environments without seeded data),
the cart falls back to the `TAX_PPN_RATE` env var so existing tests do
not break.

## Why basis points

Operators talk about tax in percent, but storing percent as a float
opens the door to float-rounding bugs in money math. Basis points (1%
= 100bp) keep the value exact at integer level, and the conversion to
a fraction (`bp / 10000`) happens once, at apply-time, inside the
already-banker-rounded `multiplyMoney` helper.

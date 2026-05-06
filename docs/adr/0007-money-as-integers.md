# ADR-0007: Money as integers

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce handles money. Prices, taxes, shipping costs, discounts, payment amounts, refunds, totals. Mistakes in this area cost real merchants and real shoppers real money. They also erode trust in the platform faster than almost any other class of bug.

There are several ways to represent money in software. Each has trade-offs:

**JavaScript `number` (floating point)** — easy to use, but cannot exactly represent most decimal fractions. The classic example: `0.1 + 0.2 === 0.30000000000000004`. Rounding errors compound across calculations and become visible when totals do not match.

**Decimal libraries (decimal.js, big.js)** — accurate, but require explicit conversion at every boundary, are slow compared to native numbers, and add a runtime dependency.

**Strings** — the database can store decimals as strings ("100.00"), but every calculation requires parsing, and arithmetic in strings is awkward.

**Integers (smallest currency unit)** — store the value in the smallest unit of the currency. For Indonesian Rupiah, this is whole rupiah (no fractional unit). For US Dollars, this is cents. For Bitcoin, satoshis. Calculations are exact, fast, and use native arithmetic.

The integer approach is what payment processors, accounting systems, and serious commerce platforms use. Stripe, Shopify, and others all represent amounts as integer minor units.

For Indonesian Rupiah specifically, this is even simpler than for most currencies because the rupiah does not commonly use fractional units in practice.

A second concern is the size of the integer. JavaScript's `number` type is a 64-bit float with 53 bits of integer precision. This is enough for any plausible single price, but for aggregate calculations across millions of orders, large currency values (like wholesale invoices in IDR), or future-proofing against very large totals, `bigint` is safer.

---

## Decision

All currency values in mt-commerce are stored and computed as **integers in the smallest unit of the currency**, using `bigint` for storage and arithmetic.

The system uses a typed `Money` value object in application code, never raw numbers:

```typescript
type Money = {
  amount: bigint;
  currency: string; // ISO 4217 code, e.g., "IDR", "USD"
};
```

Database columns for currency amounts use PostgreSQL's `bigint` type. Currency codes are stored alongside as `text` columns.

Floating-point numbers are not used for money anywhere in the system. There are no `number`-typed price fields, no decimal libraries, no string-based amounts.

---

## Consequences

### Positive

Calculations are exact. Adding, subtracting, multiplying, and dividing money produces precise results without rounding errors at the representation level. Rounding still happens, but only when explicitly required (for example, when applying a percentage discount), and the rounding rules are explicit and auditable.

Performance is excellent. `bigint` arithmetic is slower than `number` arithmetic but vastly faster than decimal libraries, and the difference is invisible at the scale of a single API request.

Database storage is efficient. `bigint` columns are 8 bytes, indexed efficiently, and scan quickly.

The representation matches what payment processors expect. When the system sends an amount to Midtrans, Xendit, or Stripe, it sends an integer in minor units. There is no conversion needed at the boundary.

Auditing is simpler. A column called `total_cents` holding `12500` is unambiguous. There is no question of whether `12.5` means twelve dollars and fifty cents or twelve fifty.

### Negative

Developers must remember that the value is in minor units. Reading `priceCents: 1500000n` for an Indonesian product requires understanding that this is Rp 1,500,000, not Rp 15,000.00. This is mitigated by:

- Suffixing field names with the unit (`priceCents`, `amountSatoshi`)
- Using the `Money` value object in application code, which carries currency context
- Helper functions for formatting (`formatMoney(money, locale)`)

Display formatting requires conversion. The storefront shows "Rp 1.500.000," not "1500000." This is a one-line helper but must be applied everywhere user-visible.

JSON serialization of `bigint` is awkward. JavaScript's `JSON.stringify` does not handle `bigint` natively. The API serializes monetary values as strings in JSON (`"1500000"`) and parses them back to `bigint` on receipt. This is a small, well-defined boundary.

Indonesian Rupiah has a quirk: the smallest commonly-used unit is the rupiah itself, not a sub-unit. Some legacy systems and APIs may pass amounts as decimals (Rp 1.500.000,50) even though half-rupiah does not exist in practice. mt-commerce treats Rupiah as having no minor unit (the integer is whole rupiah), which is consistent with how Bank Indonesia and modern payment systems treat it.

---

## Specific rules

### Storage

- All amount columns are `bigint` in PostgreSQL
- All amount fields are paired with a currency code column
- Column names indicate the unit: `total_cents`, `subtotal_cents`, `shipping_cost_cents` for currencies with minor units, or just `amount` for currencies without (with the currency code clarifying)
- For Indonesian Rupiah, amounts are stored as whole rupiah

### Application code

- Money is represented as `Money = { amount: bigint, currency: string }`
- Direct arithmetic on `bigint` amounts is allowed within the same currency
- Cross-currency arithmetic is forbidden without explicit conversion
- Helper functions (`addMoney`, `subtractMoney`, `multiplyMoney`, `formatMoney`) live in `packages/core/money.ts`

### API

- Amounts in JSON are serialized as strings (`"1500000"`) to preserve precision
- Currency codes are ISO 4217 strings (`"IDR"`, `"USD"`)
- Each amount field is documented with its currency context

### Rounding

- Rounding happens only when explicitly required, such as when applying a percentage
- Rounding rules are documented per case (banker's rounding by default, with explicit rules for tax calculation per local regulation)
- All rounded values are stored after rounding; the system does not store unrounded amounts and round on display

---

## Alternatives considered

### JavaScript `number`

The simplest option, and the most dangerous. Floating-point error in money calculations is a classic class of bug. It does not always show up; when it does, it shows up in production with real money on the line. Rejected.

### `decimal.js` or `big.js`

Decimal libraries solve the precision problem but add a runtime dependency, slow down arithmetic significantly, and require explicit conversions. They are a reasonable choice in some systems, but for a TypeScript project with native `bigint` support, the native solution is simpler and faster. Rejected.

### Strings

Storing amounts as strings ("1500000.00") and parsing them at every boundary was considered and rejected. The constant parse-format cycle is wasteful, and string arithmetic is awkward. Rejected.

### Floats with rounding to two decimal places at every operation

Sometimes called "the easy way." Rejected emphatically. This is the approach that produces $0.01 discrepancies in totals, customers asking why their order shows $99.99 instead of $100, and accountants finding mysterious differences at month-end. Rejected.

---

## Implementation notes

The `Money` type and helpers live in `packages/core/money.ts` and are used throughout the system. The first pull request of mt-commerce includes:

- Type definitions
- Helper functions: `add`, `subtract`, `multiply` (by integer or fractional ratio), `format`
- Tests covering edge cases (zero, large amounts, currency mismatch, rounding)
- Linting rule that flags raw `number` types in monetary contexts (best-effort)

Database migrations include a check that currency code columns are not null where amounts are present.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — overview of how data is handled
- [Stripe documentation on amounts](https://stripe.com/docs/currencies) — a useful reference for how mature platforms handle this

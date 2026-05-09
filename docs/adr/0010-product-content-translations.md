# ADR-0010: Product content translations

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce is Indonesian by default (see [`PRODUCT.md`](../../PRODUCT.md)).
Bahasa Indonesia is the primary locale; English is the alternate. Both must
be first-class for catalog content — product titles and descriptions,
variant titles, category names — so a merchant can publish a single product
that reads naturally to a Bahasa-speaking shopper and to an English-speaking
shopper alike.

A small handful of catalog rows carry user-visible strings today:

- `products.title` — product display name
- `products.description` — long-form product copy
- `product_variants.title` — optional, present only on multi-variant
  products (size, flavor, etc.)
- `categories.name` — category display name

Each is currently a single `text` column in the chosen-by-the-merchant
language. The Indonesian-by-default rule means most stores will populate
these in Bahasa, but the schema cannot say "this is the Bahasa version" —
there is no slot for the English version, and no way for a storefront to
ask for one locale or the other.

There are several reasonable ways to localize these strings:

**Locale-suffixed columns** — `title_id`, `title_en`, `description_id`,
`description_en`. Simple to query (`SELECT title_id FROM products`) and
indexable with ordinary b-tree indexes. Each new locale, however, requires
a schema migration and changes to every read path. The list is short until
the day it isn't.

**Translation table** — `product_translations(product_id, locale, field,
value)` or row-per-locale `product_translations(product_id, locale, title,
description)`. Open-ended on locale count and lets translators work against
a stable join key. Costs a join on every product read and an extra write
on every product mutation. For v0.1, every product list and detail query
would gain a join against a table that has 2× as many rows as `products`.

**Nested JSONB per row** — `products.translations jsonb` holding
`{ "id": { "title": ..., "description": ... }, "en": {...} }`. One row,
one read; a service-level helper picks the requested locale. Postgres has
native JSONB support, GIN indexes, and operators (`->>`, `@>`) sufficient
for the catalog's needs. The trade-off is that filtering on a translated
field requires a JSONB expression rather than a plain b-tree lookup, and
updating one locale requires reading the JSONB, merging, and writing back.

**Two-system hybrid** — keep the canonical `title` column, mirror to a
translations side table, sync both. Three places to update on every write,
two to read from depending on context. Over-engineered for a v0.1 with
two locales.

The catalog's read pattern is overwhelmingly "list 20 active products" or
"fetch one product by slug." Translated-field filtering (e.g. searching
across English titles) is a v0.2-or-later concern. The write pattern is
"merchant updates one product"; bulk locale rewrites are not part of the
v0.1 admin.

---

## Decision

Translatable catalog rows store their localized strings in a single
**`translations` JSONB column**. The shape, applied to every translatable
table, is:

```json
{
  "id": { "title": "...", "description": "..." },
  "en": { "title": "...", "description": "..." }
}
```

The fields under each locale key match the row's translatable set —
`title` and `description` for `products`, `title` for `product_variants`,
`name` for `categories`. The locale keys are ISO 639-1 codes; v0.1 uses
`id` and `en`.

The HTTP wire shape stays unchanged. Storefront and admin responses
continue to expose flat `title`, `description`, and `name` strings. The
API resolves the requested locale on the server side, picking from the
JSONB blob and falling back when the requested locale is missing, before
the wire mapper runs.

Locale resolution follows a small, ordered chain:

1. The requested locale (from `?locale=` query param, or the
   `Accept-Language` header when the query param is absent).
2. The default locale (`id`).
3. The first locale present on the row.
4. Empty string if the JSONB is empty (a defensive case the schema
   discourages but does not hard-prohibit).

Unknown or malformed `?locale=` values are silently coerced to the
default. The set of accepted locale codes lives in
`apps/api/src/modules/catalog/i18n.ts` as `KNOWN_LOCALES = ["id", "en"]`.

---

## Consequences

### Positive

One row, one read. List queries do not gain a join. Detail queries do not
gain a join. The hot path — `/storefront/v1/products` — keeps the same
plan it had before.

The wire contract stays stable. Existing SDK consumers and the storefront
read the same `title` and `description` they always have; the only
difference is that the API now decides which translation to send back.
This was a deliberate constraint: a parallel Track B is adding `locale`
plumbing to the SDK without changing types.

Adding a third locale is a code change, not a schema migration — extend
`KNOWN_LOCALES` and seed the new locale's keys into the JSONB. The schema
does not need to know about new locales.

JSONB is a typed column in Drizzle; the schema declarations carry a
`Translations<F>` shape so TypeScript catches misuse at the boundary.

### Negative

JSONB queries cannot use simple b-tree indexes. Migration 0017 addresses
this for product search: it adds a generated `tsvector` column on
`products` that concatenates titles (weight A) and descriptions
(weight B) for both locales, indexed by GIN. The catalog repository
now uses `websearch_to_tsquery('simple', ...)` against that column
instead of the original ILIKE-on-JSONB predicate, lifting the
single-locale and per-row-scan limitations originally recorded here.

Updating one locale is a read-merge-write. The admin's "edit product"
endpoint loads the row, merges the patch into the existing JSONB, and
writes the whole column back. This is fine at the scale of a single
admin user editing one product at a time. Bulk locale updates would need
a smarter merge path; v0.1 does not have one.

The fallback chain is convenient but quiet. A storefront that asks for
`?locale=en` against a row that only has `id` will see Indonesian text
and no warning. We accept this trade — silently falling back is the
right behavior for shoppers, even if it leaves a translation gap less
visible than a hard error would. The admin will surface translation
completeness as the catalog UI matures.

The JSONB column is `NOT NULL DEFAULT '{}'::jsonb`. An empty object is a
valid (if degenerate) state and the resolver handles it. Migrations that
introduce a new translatable field on an existing table need to remember
that older rows may not have it under any locale.

---

## Specific rules

### Storage

- `translations jsonb NOT NULL DEFAULT '{}'::jsonb` on every translatable
  table.
- The shape per locale matches the row's translatable field set. No
  field name is duplicated outside the JSONB column for the same string.
- Locale keys are ISO 639-1 lowercase; field keys are camelCase to match
  the wire shape.

### Application code

- The schema declarations type the column as `Translations<F>`, where `F`
  is the union of translatable field names for that table.
- Mappers call `resolveTranslations(translations, locale)` to pick the
  flat `{ title, description }` shape before composing the domain DTO.
- The service exposes an optional `locale?: string` parameter on every
  read method. Unset defaults to `id`.
- Inputs to create/update accept the full `translations` object. The
  legacy single-string shorthand is intentionally not supported — the
  caller must specify which locale they are writing.

### HTTP

- `?locale=id|en` selects the response locale.
- `Accept-Language` is parsed for the primary tag when `?locale=` is
  absent.
- Unknown / malformed values fall back to `id` silently.
- The wire shape does not gain a `translations` field. The response
  exposes the resolved flat strings.

### Cart and checkout snapshots

- Cart line items continue to carry only `variantId` + captured price.
  Titles are resolved at read time using the requesting user's locale.
  This keeps a guest cart that started in `id` and resumes in `en` from
  showing stale titles.
- The order_intent snapshot keeps the same shape it had — a list of
  `{ variantId, quantity, unitPrice }`. Titles are not snapshotted at
  completion; the future Order module will resolve titles from the
  catalog (or, when audit immutability becomes a hard requirement,
  capture the full `translations` blob then). Recorded as a follow-up.

---

## Alternatives considered

### Locale-suffixed columns (`title_id`, `title_en`)

Rejected. Each new locale requires a schema migration; every read path
has to know which suffix to read. A platform that hopes to be useful
beyond Indonesia and English will hit this wall quickly, and the cost of
hitting it is wider than the cost of adopting JSONB upfront.

### Dedicated translation table

Rejected for v0.1. The join cost on every list and detail query is real,
and the v0.1 catalog has only two locales. The pattern becomes
attractive when locales are many and translation workflows need a stable
join key (translator tools that diff by row); we will revisit if
translation tooling pushes us there.

### Two-system hybrid (canonical column + translations table)

Rejected. Three writes per mutation, two read paths to keep in sync,
and ambiguity about which is authoritative when they drift. The
operational cost is paid every day for a benefit that does not show up
until much later.

### Per-locale Postgres schemas / tenants

Out of scope. mt-commerce is single-tenant per the v0.1 architecture;
multi-tenant patterns are an open question recorded in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

---

## Implementation notes

The migration `0007_product_translations.sql` does three things in
sequence:

1. Adds `translations jsonb NOT NULL DEFAULT '{}'::jsonb` to `products`,
   `product_variants`, and `categories`.
2. Backfills the JSONB from the existing single-string columns. Every
   existing row's `title`, `description`, and `name` lands under the
   default locale slot (`id`). The backfill is lossless: no row's
   user-visible text disappears.
3. Drops the now-redundant single-string columns: `products.title`,
   `products.description`, `product_variants.title`, `categories.name`.

A GIN index on the raw `translations` JSONB column is not added: catalog
reads still resolve translations row-by-row, and the bulk-of-the-volume
predicates (status, deleted_at, category) are b-tree friendly. Search
moved to a separate `search_vector` generated column with its own GIN
index in migration 0017 — see the "Negative" section for the rationale.

Service helpers live in
`apps/api/src/modules/catalog/i18n.ts`:

- `KNOWN_LOCALES` — the accepted locale set.
- `DEFAULT_LOCALE` — `"id"`.
- `resolveTranslations(translations, locale, defaultLocale?)` — picks
  the flat `{ field: string }` shape, applying the fallback chain.
- `parseLocale(value, fallback?)` — coerces an arbitrary string to a
  member of `KNOWN_LOCALES` or to the fallback.

Route helpers live in
`apps/api/src/modules/catalog/routes/locale.ts`:

- `localeFromRequest(c)` — reads the `?locale=` query param first, then
  the `Accept-Language` header, then falls back to `DEFAULT_LOCALE`.

The wire shape stays in `routes/wire.ts`. The mappers in `mappers.ts`
take an optional `locale` parameter and pass it to
`resolveTranslations`.

The cart and checkout modules are not changed by this ADR. Cart line
items already resolve titles at read time (the cart repository captures
only `variantId` and price); checkout's order_intent snapshot did not
capture titles in the first place. The follow-up captured above is
about whether order_intents _should_ capture the full `translations`
blob when the Order module ships.

---

## Related

- [`PRODUCT.md`](../../PRODUCT.md) — Indonesian-by-default principle
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — overview of how data is handled
- [ADR-0005](./0005-modular-monolith.md) — modules and their boundaries
- [ADR-0007](./0007-money-as-integers.md) — companion decision on a small
  domain primitive (money) that is also resolved at the service boundary

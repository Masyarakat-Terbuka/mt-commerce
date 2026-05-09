# ADR-0020: Indonesian regions as four owned tables

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** mt-commerce maintainers

---

## Context

Indonesian addresses are administrative four-deep: **provinsi** (province) → **kota/kabupaten** (city/regency) → **kecamatan** (subdistrict) → **kelurahan/desa** (village). Domestic shipping rates, courier coverage, and government tax filings all key off these levels using BPS codes (Badan Pusat Statistik, the national statistics agency).

Storefront and admin both need:

- A region picker that walks the levels — pick a province, then the cities for that province, then the subdistricts, etc. Each step has 30–500 options; the next-level lookup has to be fast.
- Validated address writes — a `customer_addresses` row should refer to a real subdistrict-in-the-correct-city, not a free-text typo.
- Stable identifiers that join against external data — courier rate tables (Biteship, JNE, J&T) all key off BPS codes; a non-BPS surrogate id would mean a translation step on every shipping calculation.
- Address localisation that survives schema evolution — re-importing the BPS reference set should not orphan customer addresses written against last year's snapshot.

Three options exist for where this data lives:

**Owned tables.** `provinsi`, `kota_kabupaten`, `kecamatan`, `kelurahan` — four tables, each row keyed by its BPS code, parent FK to the level above.

**A 3rd-party API.** Biteship, RajaOngkir, and a few smaller services offer the region tree as an API; pick one, cache, walk it on demand.

**A flat denormalised string column.** `customer_addresses.region` text, free-form. Easiest to write, hardest to validate.

---

## Decision

mt-commerce **owns the region tree as four tables in its own database**. Each table has:

- `id` — the BPS code as text (`"31"` for DKI Jakarta, `"3171"` for Jakarta Pusat, etc.). This IS the primary key — there is no separate surrogate ULID.
- `name` — the canonical Bahasa Indonesia label.
- For non-top levels, a non-null FK to the parent's `id`.
- `created_at` — for diagnostic auditing of seed runs; no `updated_at` because the canonical names rarely change and the seed pipeline reapplies whole.

Four tables, not one self-referential one, because the four levels have different cardinalities and shipping/tax rules attach at different levels (rates often differ by `kota_kabupaten` but not by `kelurahan`); the type-distinct shape keeps the joins readable.

The seed dataset is loaded from a versioned static JSON file checked into the repository at `apps/api/src/scripts/seed/regions/`. The seed is idempotent — re-running upserts every row, never deletes one that an existing customer address points at.

`customer_addresses` carries four FKs (`provinsi_id`, `kota_kabupaten_id`, `kecamatan_id`, `kelurahan_id`) on the row. The FKs are nullable down the chain — an address may stop at `kecamatan` if the customer doesn't pick the kelurahan — but the parent integrity is enforced (you can't have a kelurahan without its kecamatan).

---

## Consequences

### Positive

The region picker hits a paginated `/regions/kota_kabupaten?provinsi_id=31` endpoint with no external dependency. P50 is a single index lookup against a few-thousand-row table on a deployment that already has the connection pool open. There is no API key to rotate, no quota to monitor, no rate-limit budget to spend on the most common storefront UI interaction.

Address validation is a database constraint, not a runtime API call. A `customer_addresses` insert with a `kelurahan_id` that does not exist (a stale picker, a manipulated client) fails at the DB layer with a foreign-key violation. The application layer doesn't have to re-check.

BPS codes as the primary key let mt-commerce join against external rate tables without translation. Biteship's rate API takes a `destination_district_id` that operators map to a `kecamatan_id`; the value flows through unchanged. A future JNE adapter will take the same `kota_kabupaten_id` directly. No lookup table, no normalisation step.

Customer addresses are durable across re-seeds. The seed script is `INSERT … ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name` — names get refreshed, the rows themselves stay. Every existing customer address keeps its FKs intact even when the canonical names change.

The deployment ships ready-to-use. An operator on a fresh VPS doesn't sign up for a third-party regions API to make their store work — they migrate, seed, and start. This matters: the merchant audience explicitly includes operators with no developer on staff.

The four-table shape is plain SQL. Backups, restores, and DR cover it like any other table. An operator running `pg_dump` gets the regions; an operator restoring from that dump has them back. There is no out-of-band synchronisation.

### Negative

Mt-commerce ships a static dataset that goes stale. BPS publishes annual updates; new kelurahan are added when villages split, names change when subdistricts are renamed. Operators relying on those changes have to update the seed file. We document the refresh cadence (target: once per year against the latest BPS publication) and provide a re-seed script that updates names without disturbing existing addresses.

Coverage is currently Indonesia-only by design. A future market (Singapore, Malaysia, the Philippines) would need a parallel set of tables or a generalised "address tree" abstraction. The mt-commerce target audience for v0.1 is Indonesian merchants; we accept the regional bias.

The picker UI has to walk the tree level-by-level — the storefront cannot type-ahead a free-form "Jakarta Pusat" search and resolve to the right `kota_kabupaten_id` without a search endpoint. We added one (`/regions/search?q=…`) on the read API, but the default flow is the four-step picker.

The static seed file is large (≈80,000 rows of kelurahan). The seed script handles it with a streaming insert; the migration is one-time-ish but the file lives in the repo and inflates the clone size by ~3MB. We accept the size for the convenience of having the data with the code.

Schema migrations against the regions tables are awkward because the data is so much larger than the schema. A column rename forces a re-seed. The tables are designed to be read-mostly, with the seed as the authoritative writer; ad-hoc schema churn is unusual.

---

## What this module does NOT do

- **Geocoding.** No lat/lng lookup, no distance-from-warehouse calculation. The region tree is administrative, not geographic. Geocoding is delegated to the courier integrations (Biteship returns lat/lng on its rate response).
- **Postal-code validation.** Postal codes are stored on `customer_addresses.postal_code` as a text column with a regex check (`/^\d{5}$/`). They are not joined against the region tree because the BPS data does not include postal codes and the relationship is many-to-many.
- **Multi-locale region names.** Names are Bahasa Indonesia only. An English mt-commerce admin sees "Provinsi DKI Jakarta" because that is what the data says. The names are proper nouns and translation would invite errors.
- **Historical record of region renames.** When a region is renamed in the seed update, the row's `name` is overwritten. Old shipping labels printed before the rename keep their text snapshot; new addresses use the new name. We don't keep a `name_history` for it.
- **Cross-region rate computation.** The tables hold the tree; rate calculation lives in the shipping module and the courier plugins.

---

## Alternatives considered

### A 3rd-party regions API (Biteship, RajaOngkir)

Considered seriously and rejected because:

- The picker is the most-clicked UI in the customer's first interaction with the storefront. A regions API hiccup degrades sign-up directly, and the merchant has no recourse.
- The region tree is foundational data — it is also used by `store_settings.shipping_origin_*`, by tax filings, and by the warehouse picker. Wiring four downstream features through an external API multiplies the failure modes.
- The provider has rate limits and pricing that don't align with a self-hosted commerce platform. A free tier will not cover a busy store; the paid tier is per-API-call for data that is essentially static.
- Operators in markets where the courier provider hasn't built coverage (a city in Papua, a kelurahan that just split) get a worse experience than the BPS data they could ship statically.

The 3rd-party API is the right place for _rate calculation_ (which depends on the courier's network) but not for _the address tree_ (which is a fact about Indonesia).

### One self-referential table (`regions(id, parent_id, level)`)

Considered for the simplicity. Rejected because:

- The four levels are queried with different shapes — a kelurahan picker only ever wants one level filtered by parent; a single table forces the consumer to remember `WHERE level = 'kelurahan' AND parent_id = ?` everywhere.
- Different levels carry different metadata. Some kota_kabupaten have a `is_kota` boolean (city vs. regency) that doesn't apply to kelurahan. Splitting the tables lets each carry its own columns without nullable boilerplate.
- The four-table shape matches how downstream features reference it. `customer_addresses.kota_kabupaten_id` is more readable than `customer_addresses.region_id` plus a "this one is the kota_kabupaten level" convention.

### Free-text region columns on the address row

Cheapest to write, impossible to validate. Rejected because shipping rate calculation, tax compliance, and the courier plugins all need a typed reference. A typo in "Jakarta Selatan" silently downgrades the rate; we'd rather fail fast at the FK.

### A government-owned API (BPS hosts a directory service)

The BPS publishes the dataset but does not run a stable production-grade API for it. We can pull the data from them at seed time; we cannot consult their service on the request path.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module boundaries; the regions tables are read-only from the perspective of every module that consumes them.
- [ADR-0013](./0013-shipping-fulfillment-lifecycle.md) — courier integrations key off the BPS codes carried on the address row.
- [ADR-0016](./0016-store-settings-singleton.md) — `store_settings.shipping_origin_*` reference the same tables.
- `apps/api/src/db/schema/provinsi.ts`, `kota_kabupaten.ts`, `kecamatan.ts`, `kelurahan.ts` — the four schemas.
- `apps/api/src/scripts/seed/regions/` — the seed dataset and loader.
- `apps/api/src/db/schema/customer_addresses.ts` — the FKs that anchor a customer address to the tree.

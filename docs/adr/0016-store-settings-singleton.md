# ADR-0016: store_settings as a singleton row

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

A commerce platform has a small set of merchant-wide settings that don't belong to any specific product, order, or customer: the store's display name, the default currency and locale, the default tax rate, the shipping origin address, whether email and WhatsApp notifications are enabled. These are global facts the api consults on most requests.

Two patterns exist:

**Key/value table.** A `settings(key text, value jsonb)` table where each row stores one setting. Flexible — adding a new setting is a row insert, not a migration. Loose — every reader has to know what shape `value` should be for each key, and a typo in `key` is silently fine until a reader expects it.

**Single typed row.** A `store_settings` table with one row, columns shaped to the actual settings, and a constraint forcing exactly one row to exist. Schema changes for new settings, but every reader gets static types.

There is also a question of how the singleton invariant is enforced. Pure application convention is fragile (a manual `INSERT` into the database breaks it). A CHECK constraint on a sentinel id makes "exactly one row" a database-level fact.

A third concern: when does the row come into existence? On migration? On first read? On first PATCH?

---

## Decision

`store_settings` is a **single typed row**, keyed by `id = 'singleton'` with a CHECK constraint enforcing the sentinel. The PRIMARY KEY plus the CHECK make the singleton invariant a database fact.

The row is **inserted lazily on first read**. The settings service's `getSettings()` reads, and on null inserts the defaults row, then re-reads. There is no separate provisioning step in the seed. There is never a "settings not found" path — `getSettings()` always returns a `StoreSettings`.

Two simultaneous first-reads can each see no row; the PRIMARY KEY makes at most one insert succeed; the loser catches `23505` and re-reads. No application lock; the database is the serialization point.

---

## Consequences

### Positive

Discoverability. An engineer looking at the settings shape opens `store_settings.ts` and sees the actual columns. There is no second file to consult, no list of "known keys" to keep in sync, no "what's the right shape for `value` when `key = 'shipping_origin_phone'`?" lookup. The schema is the documentation.

Type safety end to end. The Drizzle row type infers the column types; the mapper produces a `StoreSettings` domain object with concrete fields; the OpenAPI schema is generated from the domain object; the SDK gets typed access. No `Record<string, unknown>` escape hatch, no zod-parse on every read, no jsonb extraction in queries.

Lazy first-read keeps the wire contract simple. Every caller of `getSettings()` gets a `StoreSettings` — never `null`, never "uninitialized." The PATCH path never needs to handle "settings don't exist yet"; it ensures the row before applying the patch. The seed does not need to remember to create the row, and a fresh database that has never run the seed still works.

The singleton invariant is enforced by the database, not by the application. A misbehaving migration that tries to insert a second row gets a PRIMARY KEY violation. A manual `INSERT INTO store_settings (id, ...) VALUES ('not-singleton', ...)` gets a CHECK violation. The only legitimate pattern is `UPDATE store_settings SET ... WHERE id = 'singleton'`, which is what the repository emits.

The migration is hand-written (`0016_settings.sql`) because Drizzle does not generate the CHECK clause directly; the schema file mirrors the column shape so the row type compiles. This is an asymmetry but a small one — the migration is the source of truth for the constraint, the schema file is the source of truth for the columns, and the column lists agree.

### Negative

A new setting requires a migration. Adding a "default packaging weight" or a "support email" column means schema review, a migration file, and a deploy. A KV table would be a row insert. We accept the migration cost in exchange for type safety; the rate of new settings is low (one or two per quarter at most).

The row is not portable across stores. The schema bakes the "one store" assumption into the database — there is no `store_id` column anywhere. This is intentional for v0.1 (mt-commerce is single-tenant per deployment) and is recorded as a non-feature below. A future multi-tenant variant would replace the singleton constraint with a `(store_id)` unique key.

Lazy first-read means the row is created by the first request that touches settings, which is usually the api boot's health-check endpoint. An operator who reads the database before the api has booted will not find the row. We treat this as a non-issue — the api boots the row into existence before anything else needs it — but it is non-obvious behaviour worth documenting in the module README.

The `SettingsService.updateSettings` PATCH carries a long `if (patch.x !== undefined) ...` chain because each column is a separately-patchable field. The shape is mechanical and could be condensed with reflection, but the explicit form keeps the per-field semantics visible (some patches re-read for resolved region names; some are pure column updates). We accept the verbosity.

---

## What this module does NOT do

- **Multi-tenant settings.** No `store_id`, no per-tenant overlays. Single deployment, single store, single row.
- **Environment overlays.** No "this setting is `X` in production but `Y` in staging" mechanism. Environment-specific config lives in environment variables, not in settings.
- **Scheduled changes.** No "apply this rate change at midnight" support. Settings change when an admin clicks save.
- **History or audit trail.** v0.1 does not log changes to settings. The audit module could record them; settings are not yet wired in. A future pass adds `auditService.recordEvent({ entityKind: "settings", ... })` to the PATCH path.
- **Per-section locking.** The PATCH is whole-row; there is no "edit just the shipping origin" lock. Two operators editing the page concurrently use last-write-wins. Acceptable for v0.1 — the page is small and the contention is theoretical.

---

## Alternatives considered

### Key/value table

A `settings(key text PRIMARY KEY, value jsonb)` table was considered. It removes the migration cost on new settings and is a natural fit for highly-dynamic settings. It was rejected because:

- Discoverability collapses: there is no place that lists every known key. A new contributor cannot grep the codebase for "what settings exist?" — they have to read every place that calls into the settings service and reverse-engineer the keys.
- Type safety becomes a layered runtime check: every reader narrows `value: unknown` to its expected shape. A change to the shape on the writer side and a stale narrowing on the reader side becomes a runtime bug, not a compile error.
- The settings we have are not particularly dynamic. Currency, locale, tax rate, shipping origin, notification toggles — these are a fixed shape that the codebase needs strong types over. A KV table is the right answer when the keys are operator-defined or change frequently. Neither is true here.

The KV pattern remains the right answer for a different problem (per-customer preferences, per-product custom attributes), and v0.1 does not need either of those yet.

### Environment-variable-only settings

Storing all of these in env vars would mean no schema and no admin UI. It was rejected because operators need to be able to change the store name, default currency, and shipping origin without redeploying. The merchant-editable settings belong in the database; the deployment-time settings (database URL, SMTP host, API keys) stay in env vars.

### Settings as a config file the operator edits

A YAML or TOML file in the api's deployment directory was considered. It would let operators commit settings to git and review changes through PRs. It was rejected because non-developer admins cannot edit a config file safely, and the mt-commerce operator audience explicitly includes non-developer admins. The settings need to be editable through the admin UI, which means they need to be in the database.

### Multiple settings tables (one per section)

`store_general`, `store_tax`, `store_shipping`, `store_notifications` as four separate singleton tables. It was rejected because the section boundaries are admin-UI concerns, not database concerns. The settings service exposes a single `getSettings()` that all callers use; splitting the storage would force a join on every call to recompose the shape. The single-row form is what the readers want.

---

## Related

- [ADR-0007](./0007-money-as-integers.md) — `bigint`, `currency` patterns the settings table inherits (the settings row carries the default currency only; amounts on actual money rows live elsewhere).
- `apps/api/src/db/schema/store_settings.ts` — the schema.
- `apps/api/drizzle/migrations/0016_settings.sql` — the hand-written migration with the CHECK constraint.
- `apps/api/src/modules/settings/` — the service and routes.

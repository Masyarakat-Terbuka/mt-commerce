# Settings module

Stores merchant-wide configuration: store name, default currency, default
locale, default tax rate, shipping origin (full Indonesian address), and
notification channel toggles.

## Storage

A single `store_settings` row keyed by the sentinel id `'singleton'`.

- `id text PRIMARY KEY DEFAULT 'singleton'` with a `CHECK (id =
  'singleton')` — together they make "exactly one row" a database fact,
  not a service convention.
- `default_currency text NOT NULL DEFAULT 'IDR'`
- `default_locale text NOT NULL DEFAULT 'id'`, gated by `CHECK (default_locale
  IN ('id', 'en'))`.
- `default_tax_rate_id text NULL` — FK to `tax_rates(id)` with
  `ON DELETE SET NULL` so archiving the referenced rate does not orphan
  the singleton.
- Region columns (`shipping_origin_*`) are plain `text` without FKs —
  same shape `customer_addresses` keeps them. The admin UI sources the
  dropdown values from the region tables, so values arriving here are
  already canonical.

The `0016_settings.sql` migration is hand-written so the CHECK constraints
and the FK clause stay explicit (drizzle-kit does not model CHECK).

## Service surface

`SettingsService`:

| method | purpose |
| --- | --- |
| `getSettings()` | read; lazily inserts the default row on first call |
| `updateSettings(patch)` | partial update; ensures the row exists first |

The lazy-insert removes the "settings not found" branch from every caller.
Concurrent first-reads converge via the PRIMARY KEY: the loser swallows
SQLSTATE `23505` and re-reads.

## Routes

- `GET /admin/v1/settings`
- `PATCH /admin/v1/settings`

Both gated by `requireAuth` + `requireRole("owner", "admin", "staff")`.

## Wire shape

Reads embed resolved region NAMES alongside the BPS ids
(`shippingOriginProvinsiName`, `…KotaKabupatenName`, `…KecamatanName`,
`…KelurahanName`) from a single LEFT-JOIN read. Same pattern as
`customer_addresses`. The names are optional on the wire; older clients
keep working, newer clients render `name ?? id`.

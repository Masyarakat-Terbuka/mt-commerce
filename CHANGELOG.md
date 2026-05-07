# Changelog

All notable changes to mt-commerce are documented in this file.

The format is based on [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until v0.1.0 is tagged, all entries live under **Unreleased**. Pull requests
that affect users, operators, or contributors should add a line here.

---

## [Unreleased]

### Added

#### Repository foundation

- MIT license, `README.md` (English) and `README.id.md` (Bahasa Indonesia).
- `PRODUCT.md` (what we are building and why) and `ARCHITECTURE.md` (how the system is shaped).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md`.
- Bun workspaces with shared TypeScript configuration (`tsconfig.base.json`).
- Issue templates for bugs, features, and tasks; pull request template.
- GitHub Actions CI for lint, typecheck, and test.
- Architecture Decision Records ADR-0001 through ADR-0009 covering the headless architecture, license choice, Drizzle over Prisma, REST over GraphQL, modular monolith, Astro storefront, money as integers, plugins as npm packages, and the shadcn preset.

#### Local development

- Root `docker-compose.yml` provisioning PostgreSQL and Redis.
- `.env.example` with annotated configuration for the API, admin, and storefront.

#### Core API (`apps/api`)

- Hono application on Bun with TypeScript end to end.
- `/health` and `/ready` endpoints for orchestrators.
- Structured JSON logging via pino, with pretty-printing in development.
- Request-ID middleware propagating a unique ID through every log line.
- Standard error shape (`{ error: { code, message, details } }`) via the error-handler middleware.
- Zod-based request validation, with `@hono/zod-openapi` generating the OpenAPI document.
- Swagger UI mounted in development.
- CORS middleware honoring `CORS_ORIGIN`.
- Rate-limiting middleware backed by Redis.
- Idempotency-key middleware for mutating endpoints.
- Vitest setup with reference unit and integration tests.

#### Database (`apps/api/drizzle`)

- Drizzle ORM with `drizzle-kit` for schema-first migrations.
- PostgreSQL connection pool configured from `DATABASE_URL`.
- Migrations `0000_init` through `0006_product_images` covering core tables, catalog, auth, customer, cart, checkout, and product images.

#### Authentication and authorization (`modules/auth`)

- Better Auth integration with the Hono API.
- Staff `users` and customer `customers` tables with email/password registration and login.
- HTTP-only secure session cookies; Argon2id password hashing.
- Roles enum (`owner`, `admin`, `staff`, `viewer`) and `requireAuth` / `requireRole` middlewares.
- API keys with scopes for external services, with rate-limit enforcement.
- Tests covering middleware, services, API keys, rate limiting, and auth routes.
- Authentication overview at `docs/api/authentication.md`.

#### Catalog (`modules/catalog`)

- Schemas for `products`, `product_variants`, `categories`, `product_categories`, and `inventory_levels`.
- Admin CRUD endpoints under `/admin/v1/products`, `/admin/v1/categories`, and variant management.
- Public storefront endpoints under `/storefront/v1/products` with pagination, filtering, and sorting; product detail by slug.
- Demo catalog seed for fresh developer environments.
- Module README with the public surface and conventions.

#### Customer (`modules/customer`)

- `customers` and `customer_addresses` tables with Indonesian address fields (provinsi, kota/kabupaten, kecamatan, kelurahan, postal code).
- Region schemas keyed by BPS codes for `provinsi`, `kota_kabupaten`, `kecamatan`, and `kelurahan`.
- Customer profile and address endpoints (admin and storefront).
- Indonesian address-hierarchy validator.
- Sample regions seed (3 provinces, 5 kota/kabupaten, 8 kecamatan, 12 kelurahan) for the dev environment.
- Module README.

#### Cart and checkout (`modules/cart`, `modules/checkout`)

- `carts` and `cart_items` schemas with guest + customer cart support.
- Cart creation, retrieval, line management, and totals (subtotal, tax, shipping, total).
- Checkout state machine in `modules/checkout/state.ts` with documented transitions and exhaustive unit tests.
- Checkout endpoints for each transition; idempotency-key support enforced.
- `checkout_events` and `order_intents` schemas for the audit and order-handoff path.
- Tests covering services, routes, state machine, idempotency, and totals.
- Module READMEs documenting both flows.

#### `packages/core`

- `Money` type and helpers: integer-only arithmetic, currency-aware addition and conversion.
- ULID-based ID generation with typed prefixes (`prod_`, `ord_`, `cust_`, etc.).
- Shared error types.
- Test coverage for money math and ULID generation.

#### `packages/sdk` (`@mt-commerce/sdk`)

- Typed fetch-based HTTP client (~470 lines) covering the public API surface.
- TypeScript types generated from the API's OpenAPI document.
- Helpers for authentication, error handling, and idempotency.
- Client tests.
- README with usage examples.

#### Admin app (`apps/admin`)

- Vite + React + TypeScript scaffold.
- Tailwind CSS with the shadcn/ui preset (button component installed; theme provider in place).

#### Storefront (`apps/storefront`)

- Astro scaffold with `@astrojs/react` for interactive islands.
- Tailwind CSS for styling.
- Bahasa Indonesia as the default language with English at `/en/`; `i18n/id.json` and `i18n/en.json` translation files.
- Home page, product list (`/products`), and product detail (`/products/[slug]`) — server-rendered.
- React islands: `AddToCartButton`, `CartDrawer`, `ProductGrid`, `ProductDetail`, `VariantSelector`.
- `BaseLayout.astro` shared across pages.
- Rupiah formatting applied throughout.

### Notes

- This release is **not yet tagged**. The `Unreleased` section reflects what
  is on `main` and will be split into a versioned `[0.1.0]` block when v0.1
  is cut.
- Several streams are intentionally out of scope for v0.1 and will appear
  in future releases: order, payment, shipping, tax, notification, webhook,
  and the plugin loader. See `docs/v0.1-checklist.md` for the live picture.

---

## How to write entries

When you open a pull request that affects users, operators, or contributors,
add a line under `## [Unreleased]` in the appropriate section. Use the
imperative voice and link the PR or issue when relevant.

```markdown
### Added
- WhatsApp notification adapter for order confirmation (#42).

### Fixed
- Cart totals no longer drop the rupiah when shipping is zero (#57).
```

The categories, in the order Keep a Changelog defines them, are:

- **Added** — for new features.
- **Changed** — for changes in existing functionality.
- **Deprecated** — for soon-to-be-removed features.
- **Removed** — for now-removed features.
- **Fixed** — for bug fixes.
- **Security** — for vulnerabilities and the fix that addressed them.

Internal-only changes (refactors with no user-visible effect, CI tweaks,
test reorganization) do not need an entry.

[Unreleased]: https://github.com/masyarakat-terbuka/mt-commerce/compare/v0.1.0...HEAD

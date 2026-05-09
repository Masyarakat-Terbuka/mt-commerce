# Architecture

This document describes how mt-commerce is shaped. It is the technical companion to [`PRODUCT.md`](./PRODUCT.md), which describes what the project is and what it values.

The ideas here are stable. The wording will improve as the project does. Significant decisions are recorded as ADRs in [`docs/adr`](./docs/adr).

---

## Overview

mt-commerce is a headless commerce platform. Three pieces, communicating over HTTP:

```
   ┌───────────────┐   ┌──────────────────┐   ┌──────────────┐
   │  Admin app    │   │  Storefront      │   │  Your app    │
   │  (React)      │   │  (Astro)         │   │  (anything)  │
   └───────┬───────┘   └────────┬─────────┘   └──────┬───────┘
           │                    │                    │
           └────────────────────┼────────────────────┘
                                ▼
                        ┌───────────────┐
                        │   API (Hono)  │
                        └───────┬───────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          PostgreSQL          Redis          Plugins
```

The API is the engine. It holds the data, enforces the rules, and exposes everything through a documented HTTP interface. The admin and storefront are reference clients of that API. Anyone can build other clients — a different storefront, a mobile app, a marketplace sync worker, an internal tool — and they all consume the same API the same way.

Internally, the API is a modular monolith. One deployable, organized into clearly bounded modules. We do not use microservices. They add complexity that this project does not need.

---

## Repository structure

mt-commerce is a single repository with workspaces, managed with Bun.

```
mt-commerce/
├── apps/
│   ├── api/                  # Hono backend, the commerce engine
│   ├── admin/                # Vite + React admin app
│   └── storefront/           # Astro storefront
├── packages/
│   ├── core/                 # Shared types and utilities
│   ├── sdk/                  # TypeScript client SDK
│   └── plugins/              # First-party plugins
│       ├── payment-midtrans/
│       ├── shipping-biteship/
│       └── notification-whatsapp/
├── docs/
│   ├── adr/                  # Architecture Decision Records
│   ├── deployment/           # Deployment guides
│   └── id/                   # Bahasa Indonesia documentation
└── docker-compose.yml        # Local development stack
```

Keeping the API, the SDK, and the apps in one repository lets type changes flow through immediately, and lets a single pull request cover the whole system when needed.

---

## The API

The API is a Hono application written in TypeScript and run on Bun. It serves all HTTP traffic for both the admin and the storefront, separated by route prefixes.

### Conventions

Routes are organized by audience and version:

```
/admin/v1/products
/admin/v1/orders
/storefront/v1/products
/storefront/v1/cart
/storefront/v1/checkout
```

Admin routes require an authenticated staff user. Storefront routes are public, with optional customer authentication.

Every input is validated with Zod. Schemas are the source of truth, and the same schemas generate the OpenAPI documentation through `@hono/zod-openapi`.

Errors are typed and consistent. Every error has a stable code and a clear shape:

```json
{
  "error": {
    "code": "product_not_found",
    "message": "Product 'prod_abc123' was not found.",
    "details": { "productId": "prod_abc123" }
  }
}
```

Responses are versioned through the URL prefix (`/v1/`). Breaking changes happen at major versions only; smaller changes are additive.

### Internal modules

The API is split into modules. Each module owns its data, exposes a service interface to other modules, and registers its HTTP routes.

```
apps/api/src/
├── modules/
│   ├── catalog/         # Products, variants, categories, inventory
│   ├── customer/        # Customers, addresses
│   ├── cart/            # Carts and cart items
│   ├── checkout/        # Checkout state machine
│   ├── order/           # Orders, fulfillments, returns
│   ├── payment/         # Payment providers, transactions
│   ├── shipping/        # Shipping providers, rates
│   ├── tax/             # Tax calculation
│   ├── promotion/       # Discounts and codes
│   ├── notification/    # Email, WhatsApp, SMS adapters
│   ├── auth/            # Authentication and roles
│   └── webhook/         # Outgoing webhooks
├── core/                # Shared infrastructure (db, events, logger)
├── plugins/             # Plugin loader
└── server.ts            # Entry point
```

Modules talk to each other through service interfaces, not direct imports. A module never reaches into another module's database tables or internal functions.

Modules also emit and listen to events for cross-module reactions. When an order is placed, the order module emits `order.placed`. The notification module listens and sends a WhatsApp message. The catalog module listens and adjusts inventory. Neither module knows about the other.

---

## Data

### Database

PostgreSQL is the source of truth. One database, with logical separation between modules.

PostgreSQL handles everything we need: relational data, JSON fields, full-text search, and strong transactional guarantees. We are not adding other databases until the constraints of Postgres are clearly limiting.

### Query layer

Drizzle ORM is the query layer. Schema is defined in TypeScript, migrations are generated from schema changes, and query results are typed end to end.

```typescript
export const products = pgTable("products", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
  currencyCode: text("currency_code").notNull().default("IDR"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

const product = await db.query.products.findFirst({
  where: eq(products.id, productId),
});
```

The reasoning behind Drizzle is recorded in [ADR-0003](./docs/adr/0003-drizzle-over-prisma.md).

### Money

Currency values are stored as integers, never floats. Indonesian Rupiah is stored in whole rupiah; other currencies in their smallest unit. We use `bigint` for storage and a typed `Money` value object in application code.

```typescript
type Money = {
  amount: bigint;
  currency: string;
};
```

Every financial calculation goes through helpers that handle rounding, addition, and conversion explicitly. This is the most error-prone area of any commerce system, and it is treated with care.

### Identifiers

Every entity has a string ID with a typed prefix: `prod_`, `ord_`, `cust_`, `pay_`. This makes logs and debugging easier and prevents accidentally passing one kind of ID where another is expected. IDs are based on ULID — sortable, URL-safe, and free of personal information.

### Audit and soft deletes

Financial entities (orders, payments, refunds) keep timestamps and an audit log of state changes. Hard-deleting these records is not allowed; we soft-delete by setting `deleted_at`. For non-financial entities, soft deletes are optional and decided per module.

### Migrations

Drizzle generates migrations from schema changes. Migrations are checked in, reviewed, and applied automatically on deployment. Forward-fixing is preferred over down-migrations.

---

## Authentication and authorization

Authentication is handled by Better Auth. It manages password hashing, session handling, and email verification, and works well with Hono.

Two distinct contexts:

- **Admin sessions** for staff users — shop owners and their teams
- **Customer sessions** for shoppers using the storefront

Both use HTTP-only, secure cookies. External services authenticate using long-lived API keys with explicit scopes.

Authorization uses a small, fixed set of roles for the first releases:

- `owner` — full access
- `admin` — full access except team and account settings
- `staff` — manage products, orders, and customers
- `viewer` — read-only

Permissions are checked at the route level via Hono middleware, and at the service level for sensitive operations. Fine-grained per-resource permissions are not part of the early releases.

---

## Background jobs and events

v0.1 ships without a queue. Cross-module reactions go through a typed in-process event bus, run synchronously on the request that emitted the event. Events are named with dot notation: `order.placed`, `payment.captured`, `inventory.adjusted`.

```typescript
await events.emit("order.placed", { orderId: order.id });

events.on("order.placed", async ({ orderId }) => {
  await notification.sendOrderConfirmation(orderId);
});
```

Catch-up work — recovering from missed payment webhooks, mostly — runs as a bulk-reconciliation HTTP endpoint the operator's host cron hits every few minutes. The api is stateless about the schedule.

A queue (BullMQ on the Redis we already run for sessions, or a Postgres-backed alternative) returns when one of these is true: a side-effect listener regularly costs more than ~200ms p95 of user-facing latency, a deployment scales beyond a single api process and needs exactly-once semantics across them, or operator-subscribed outgoing webhooks become a v0.x feature. ADR-0018 records the reasoning and the trigger conditions.

Operator-subscribed outgoing webhooks are not in v0.1.

---

## Plugins

Plugins extend mt-commerce without forking the core. A plugin is an npm package that exports a manifest.

```typescript
export default definePlugin({
  name: "@my-org/payment-foo",
  version: "1.0.0",

  paymentProviders: [FooPaymentProvider],

  events: {
    "order.placed": async ({ orderId }) => {
      /* ... */
    },
  },

  adminPanels: [{ slug: "foo-settings", component: FooSettings }],
});
```

The operator installs the plugin and registers it in `mt-commerce.config.ts`:

```typescript
import fooPlugin from "@my-org/payment-foo";

export default defineConfig({
  plugins: [fooPlugin({ apiKey: process.env.FOO_API_KEY })],
});
```

Plugins are loaded at startup. Hot-reloading is not part of the design. Simplicity here is intentional.

The first extension points are payment providers, shipping providers, notification channels, and event listeners. More will be added as the platform matures.

---

## The admin app

The admin is a single-page application built with Vite, React, and TypeScript. It consumes the API like any other client.

The stack:

- Vite for the build and dev server
- React for the UI
- TanStack Router for type-safe routing
- TanStack Query for data fetching and caching
- shadcn/ui and Tailwind CSS for the design system
- Zod for runtime validation, sharing schemas with the API

The admin holds no business logic. Every action calls the API. This keeps the engine authoritative and lets anyone replace or fork the admin without losing functionality.

Bahasa Indonesia is the default language. English is available. All strings live in translation files.

---

## The storefront

The storefront is built with Astro, with React used for interactive islands.

Astro renders product pages, category pages, and content pages as server-rendered HTML, shipping minimal JavaScript by default. Cart, search, and checkout are React components mounted as islands. The result is a storefront that loads quickly on the connections most Indonesian shoppers actually use.

The stack:

- Astro for the framework, routing, and SSR
- React for interactive islands, via `@astrojs/react`
- Tailwind CSS for styling
- The mt-commerce SDK as the typed API client

The reference storefront is a complete, shippable store. It can be used as-is, themed, or forked as a starting point.

---

## Deployment

### Local development

`docker compose up` starts the entire stack: PostgreSQL, Redis, the API, the admin, and the storefront. A developer should be able to run mt-commerce locally within a few minutes of cloning the repository.

### Production

The default production deployment is Docker Compose on a single VPS. This matches the reality of most operators — small to mid-sized merchants on a Hetzner, Biznet Gio, or IDCloudHost server. A modest VPS handles a respectable amount of traffic.

Deployment guides are provided for common Indonesian and international hosts. The same images run on Kubernetes, Fly.io, Railway, or any container orchestrator for operators who need that.

In production:

- One API process (v0.1 is single-process; multiple processes wait for the queue — see ADR-0018)
- A PostgreSQL instance, managed or self-hosted
- A Redis instance for sessions and rate-limit state
- The admin built to static files, served from any web server or CDN
- The storefront either run as a Node process for SSR, or built to static files for fully cacheable stores
- A host cron (or systemd timer) hitting `POST /admin/v1/payments/reconcile-pending` every few minutes to recover from missed payment webhooks

---

## Observability

Logging is structured. Every log line is JSON with consistent fields: `timestamp`, `level`, `module`, `requestId`, `userId`. We use pino for performance and ergonomics.

Every HTTP request gets a unique ID, propagated through logs and downstream calls.

Tracing instrumentation uses OpenTelemetry. It is wired in but optional. Operators who want tracing can connect to any OpenTelemetry-compatible backend.

Basic Prometheus metrics are exposed for request rate, latency, error rate, and queue depth. `/health` and `/ready` endpoints support orchestrators.

---

## Testing

Three layers, in order of priority:

Unit tests for pure logic — pricing calculations, tax math, state machine transitions, validators. Fast and hermetic.

Integration tests for module behavior with the database — the cart module against a real Postgres, the order state machine through real transitions.

End-to-end tests for critical user flows — adding to cart, checking out, paying, viewing the order in the admin.

Vitest covers unit and integration tests. Playwright covers end-to-end tests. The goal is not a coverage number; it is confidence in the paths that matter most, especially financial ones.

---

## Security

mt-commerce handles money and personal data. A few commitments:

- Passwords are hashed with Argon2id
- Secrets live in environment variables, never in source
- Every API endpoint is rate-limited
- Every payment operation is idempotent
- Every webhook is signed with HMAC and verified
- Personal data is minimized — store only what is needed
- HTTPS is required in production
- Vulnerability disclosure is documented in [`SECURITY.md`](./SECURITY.md)

---

## Open questions

Some decisions are still ahead of us. They will be resolved as the project encounters them:

- The full admin design system (shadcn/ui is the lean; alternatives may be considered)
- A dedicated search engine as an optional plugin once Postgres FTS hits its limits (Meilisearch and Typesense are the leading candidates)
- An S3-compatible image upload adapter for multi-process deployments (ADR-0021 captures the v0.1 local-disk decision and the seam)
- A background-job queue when synchronous listeners stop being the right shape (ADR-0018 captures the v0.1 no-queue decision and the trigger conditions)
- Multi-tenancy patterns, when relevant

---

## Decision records

Architecture Decision Records live in [`docs/adr`](./docs/adr). They capture the context, the options considered, the decision, and the consequences for each significant choice.

Accepted:

- [ADR-0001](./docs/adr/0001-headless-architecture.md): Headless architecture
- [ADR-0002](./docs/adr/0002-license.md): License
- [ADR-0003](./docs/adr/0003-drizzle-over-prisma.md): Drizzle over Prisma
- [ADR-0004](./docs/adr/0004-rest-over-graphql.md): REST over GraphQL
- [ADR-0005](./docs/adr/0005-modular-monolith.md): Modular monolith over microservices
- [ADR-0006](./docs/adr/0006-astro-storefront.md): Astro for the storefront
- [ADR-0007](./docs/adr/0007-money-as-integers.md): Money as integers
- [ADR-0008](./docs/adr/0008-plugins-as-npm-packages.md): Plugins as npm packages
- [ADR-0009](./docs/adr/0009-shadcn-preset.md): shadcn/ui preset for the admin
- [ADR-0010](./docs/adr/0010-product-content-translations.md): Product content translations as JSONB
- [ADR-0011](./docs/adr/0011-audit-log.md): Single audit_log table for cross-module mutations
- [ADR-0012](./docs/adr/0012-payment-provider-interface.md): Payment provider interface
- [ADR-0013](./docs/adr/0013-shipping-fulfillment-lifecycle.md): Shipping fulfillment lifecycle
- [ADR-0014](./docs/adr/0014-notification-listeners.md): Notification listeners on the event bus
- [ADR-0015](./docs/adr/0015-plugin-loader-extension-points.md): Plugin loader and the v0.1 extension points
- [ADR-0016](./docs/adr/0016-store-settings-singleton.md): store_settings as a singleton row
- [ADR-0017](./docs/adr/0017-better-auth.md): Better Auth for authentication
- [ADR-0018](./docs/adr/0018-no-queue-in-v0.1.md): No background-job queue in v0.1
- [ADR-0019](./docs/adr/0019-idempotency-key.md): Idempotency-Key middleware paired with row-level dedup
- [ADR-0020](./docs/adr/0020-indonesian-regions-as-own-tables.md): Indonesian regions as four owned tables
- [ADR-0021](./docs/adr/0021-local-disk-image-upload.md): Local-disk product image upload for v0.1

Future contributors can read the ADRs to understand how the system arrived at its current shape.

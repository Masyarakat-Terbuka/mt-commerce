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

mt-commerce is a single repository with workspaces, managed with pnpm.

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

The API is a Hono application written in TypeScript and run on Node.js. It serves all HTTP traffic for both the admin and the storefront, separated by route prefixes.

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

The reasoning behind Drizzle is recorded in ADR-0003.

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

Long-running or deferred work runs in BullMQ, a Redis-backed job queue. The API enqueues jobs; a separate worker process consumes them.

Examples include sending a notification after an order is placed, processing a payment webhook, generating an invoice PDF, and syncing inventory to a marketplace.

Jobs are idempotent, retryable, and observable. Failed jobs land in a dead-letter queue for inspection.

For lightweight cross-module reactions inside the same process, modules use a typed event bus. Events are named with dot notation: `order.placed`, `payment.captured`, `inventory.adjusted`.

```typescript
await events.emit("order.placed", { orderId: order.id });

events.on("order.placed", async ({ orderId }) => {
  await notification.sendOrderConfirmation(orderId);
});
```

Critical workflows that must not be lost (such as payment capture triggering fulfillment) use jobs. The trade-off between events and jobs is made deliberately, case by case.

Operators can also subscribe to events from outside through outgoing webhooks. The webhook system signs every request with HMAC, retries with exponential backoff, and tracks delivery status per subscription.

---

## Plugins

Plugins extend mt-commerce without forking the core. A plugin is an npm package that exports a manifest.

```typescript
export default definePlugin({
  name: "@my-org/payment-foo",
  version: "1.0.0",

  paymentProviders: [FooPaymentProvider],

  events: {
    "order.placed": async ({ orderId }) => { /* ... */ },
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

- One or more API processes behind a load balancer
- One or more worker processes for background jobs
- A PostgreSQL instance, managed or self-hosted
- A Redis instance
- The admin built to static files, served from any web server or CDN
- The storefront either run as a Node process for SSR, or built to static files for fully cacheable stores

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
- The search backend (Postgres full-text first; a dedicated search engine as a plugin later)
- File storage (local disk for the first releases; an S3-compatible adapter later)
- Multi-tenancy patterns, when relevant

---

## Decision records

Architecture Decision Records live in [`docs/adr`](./docs/adr). They capture the context, the options considered, the decision, and the consequences for each significant choice.

Planned ADRs:

- ADR-0001: Headless architecture
- ADR-0002: License
- ADR-0003: Drizzle over Prisma
- ADR-0004: REST over GraphQL
- ADR-0005: Modular monolith over microservices
- ADR-0006: Astro for the storefront
- ADR-0007: Money as integers
- ADR-0008: Plugins as npm packages

Future contributors can read the ADRs to understand how the system arrived at its current shape.

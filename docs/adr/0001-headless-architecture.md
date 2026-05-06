# ADR-0001: Headless architecture

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce needs a shape. Before any code is written, we need to decide how the API, the admin, and the storefront relate to each other.

Two broad options exist in the modern TypeScript ecosystem:

**Option A — Monolithic full-stack framework.** A framework like Next.js, Nuxt, SvelteKit, Remix, or TanStack Start hosts both the user interface and the API in a single application. UI components and server functions live in the same codebase. There is one deployment, one process model, and one codebase.

**Option B — Headless architecture.** The API is a standalone backend service. The admin and storefront are separate frontend applications that consume the API over HTTP, like any other client.

Both patterns have real merit. The choice has long-lasting consequences, so it deserves a deliberate decision rather than a default.

mt-commerce is not a single web application. It is **infrastructure**. The platform is meant to be extended, integrated with, and built on. Many things will consume the API:

- The reference admin
- The reference storefront
- Custom themes and storefronts built by agencies
- Plugins extending the engine
- Marketplace synchronization workers (Tokopedia, Shopee, TikTok Shop)
- WhatsApp commerce flows
- Mobile applications
- Third-party tools and developer integrations
- AI agents and automation

The shape of the API determines whether these consumers are first-class participants or awkward outsiders.

---

## Decision

mt-commerce is built as a headless platform.

The API is a standalone Hono service. The reference admin (Vite + React) and the reference storefront (Astro with React islands) are separate applications that consume the API over HTTP. The API does not depend on either of them, and either can be replaced without touching the engine.

---

## Consequences

### Positive

The API is the product. It has a stable, documented, public surface that any client can consume. This is the foundation that makes plugins, integrations, marketplace sync, mobile apps, and the developer ecosystem possible.

The reference frontends are replaceable. An agency can fork the storefront for a client, a merchant can build a custom admin, a developer can write a CLI — none of these need to touch the engine, and all consume the same well-defined API.

The architecture matches the pattern used by Medusa, Saleor, Shopify, BigCommerce, and commercetools. This is not coincidence. Commerce infrastructure is a many-to-one problem: many clients, one engine. Frameworks designed for the one-to-one case are the wrong shape.

The API can scale independently of the frontends. Heavy storefront traffic does not affect admin response times. Background workers can be deployed and scaled separately from request-serving processes.

The API is testable in isolation. End-to-end tests can target the API without spinning up a browser. Contract tests give frontend developers confidence that the API will not change beneath them.

### Negative

There are more moving parts than a monolithic framework would have. A new contributor encounters three applications, not one. Local development requires multiple processes (mitigated by Docker Compose).

Authentication across the boundary requires explicit thought — session cookies, CORS, token handling. A monolithic framework can paper over these concerns with built-in primitives that share a process.

Type safety across the boundary requires generation. We generate types from the OpenAPI document and ship them in the SDK. A monolithic framework can share types directly through imports.

Network calls between the frontends and the API add a small amount of latency that an in-process call would not have. For a commerce application, this latency is negligible compared to database and external service calls, but it exists.

Two deployments require slightly more operational care than one. Mitigated by Docker Compose for small deployments and standard container orchestration patterns for larger ones.

---

## Alternatives considered

### Monolithic full-stack framework (e.g., TanStack Start, Next.js, Remix)

A single application that handles both UI and API was considered carefully. It would mean less initial setup, fewer moving parts, and tighter type safety between client and server.

It was rejected because the API is the product, not an implementation detail of one application. Bundling the API inside a framework means:

- Plugins, integrations, and external tools must reach into framework internals or build a separate API on the side
- The API surface is shaped by the needs of one specific UI, not by general consumers
- Switching frontends later requires extracting the API after the fact, which is far more work than keeping it separate from the start
- The API is implicitly coupled to the framework's release cadence, conventions, and lifecycle

For a project building infrastructure, these trade-offs are wrong. A monolithic framework is right when the API is in service of one app. mt-commerce is in the opposite situation.

### Microservices

Splitting the API itself into multiple services (catalog service, order service, payment service, etc.) was considered briefly. It was rejected for the first releases. Microservices add operational complexity and distributed-systems concerns that a small project does not need and cannot afford.

The internal modular structure of the API (catalog, order, customer, payment, etc.) preserves clear boundaries within a single deployable. If a specific module ever needs independent scaling — and there is good evidence that it does — extraction is possible at that point. Until then, a modular monolith is the right shape. This is recorded separately in ADR-0005.

### Two frontends sharing one framework with a separate API

A hybrid pattern would put both the admin and the storefront in the same framework (for example, both as Next.js or SvelteKit applications), with a separate Hono API. This was rejected because the admin and the storefront have genuinely different needs:

- The storefront is content-heavy, SEO-critical, and needs to be fast on slow connections — Astro is a strong fit
- The admin is interactive, behind login, and benefits from a productive SPA framework — Vite + React is a strong fit

Forcing both into one framework means compromising one or the other. Keeping them separate lets each use the right tool.

---

## Implementation notes

The following commitments follow directly from this decision:

- The API serves all data and enforces all business rules. The frontends contain no business logic.
- The API is versioned (`/v1/`) and documented (OpenAPI). Breaking changes happen at major versions only.
- The SDK is the canonical client. Both the admin and the storefront use it. Third-party clients are encouraged to use it.
- CORS is explicitly configured per environment.
- Authentication uses HTTP-only cookies for session-based clients (admin, storefront) and API keys for external services.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the shape of the system as built on this decision
- ADR-0005 — modular monolith over microservices *(planned)*
- ADR-0006 — Astro for the storefront *(planned)*

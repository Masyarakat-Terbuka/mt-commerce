# ADR-0004: REST over GraphQL

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

[ADR-0001](./0001-headless-architecture.md) established that the API is the product. Many clients consume it: the reference admin, the reference storefront, custom themes, plugins, marketplace sync workers, mobile apps, third-party integrations, and developer tools. The shape of that interface affects every one of them.

Two patterns dominate modern API design:

**REST** — resource-oriented HTTP endpoints with JSON bodies. Each resource has a stable URL. Operations follow HTTP verbs. Schemas are documented through OpenAPI. This is the lingua franca of HTTP APIs.

**GraphQL** — a single endpoint, a typed schema, and clients describe the exact shape of the data they want. Resolvers fetch data per field. Subscriptions handle real-time updates.

Both patterns work. Both are deployed in production at scale. The choice is not about which is "better" in the abstract; it is about which fits the audience, the integrations, and the operational shape of mt-commerce.

The audience for the API is small to mid-sized merchants and the agencies serving them, plus the payment processors, courier services, and marketplace platforms that integrate from the outside. Most of these consumers are familiar with REST. Most of the integrations the platform needs to make — Midtrans, Xendit, Biteship, RajaOngkir, Tokopedia, Shopee — speak REST and webhooks natively.

---

## Decision

mt-commerce exposes an HTTP+JSON REST API as its canonical surface.

Routes are versioned through a URL prefix (`/v1/`) and grouped by audience (`/admin/v1/`, `/storefront/v1/`). Endpoints are resource-oriented. Validation and OpenAPI documentation are generated from a single set of Zod schemas through `@hono/zod-openapi`.

GraphQL is not part of the platform. A GraphQL surface could be added later as an additional layer over the same services if a real need appears, but the canonical API stays REST.

---

## Consequences

### Positive

REST is universally understood. A developer at an agency, a merchant's freelance contractor, or a third-party integrator can read the OpenAPI document and start calling endpoints without learning a new query language or runtime.

OpenAPI tooling is mature. Typed SDKs, mock servers, contract testing, request validators, and code generators all consume OpenAPI without friction. The same document that ships in `apps/api` powers the SDK, the admin's request layer, and any third-party integration that wants types.

HTTP caching works without extra effort. Storefront responses (product pages, category listings, search results) are cacheable at the CDN, the reverse proxy, or the browser using standard HTTP cache headers. GraphQL caching exists but requires per-query coordination and is harder to reason about.

The integration surface matches the rest of the ecosystem. Payment processors, courier APIs, marketplace platforms, and webhook providers all speak REST. Every external integration is a REST-to-REST translation rather than REST-to-GraphQL-to-REST.

Operational complexity is low. There is no resolver layer to monitor for N+1 queries, no schema federation to coordinate, no separate GraphQL gateway to deploy. The API is one Hono application with the same observability as any HTTP service.

The schemas are the source of truth in one place. Zod validates incoming requests at runtime, narrows types at compile time, and generates the OpenAPI document. No second schema language is needed.

### Negative

A client that needs data from several resources sometimes makes several round-trips. An order detail view may need the order, the customer, the line items, and the shipping address. The cost is mitigated by including commonly-needed relations in the default response and by the SDK abstracting the calls behind a single method. It is not eliminated.

Payload over-fetching is real. A list endpoint returns every field on every item, even when the caller only renders three of them. For the scale and traffic patterns of small to mid-sized merchants, the bandwidth and serialization cost is rarely the bottleneck. For very high-volume use cases, query parameters can opt into reduced field sets at specific endpoints.

Some patterns that are natural in GraphQL — deeply nested ad-hoc queries, client-shaped responses — require dedicated endpoints in REST. Each addition is a small amount of work and a small amount of API surface.

Real-time data is delivered through webhooks and Server-Sent Events rather than GraphQL subscriptions. This is a reasonable fit for commerce events but means subscriptions live outside the canonical query mechanism.

---

## Alternatives considered

### GraphQL

GraphQL has real strengths. A single endpoint, client-driven response shapes, and a typed schema reduce round-trips for clients that own both ends of the wire. For a product where the same team builds both the API and a single rich frontend, it can be the right shape.

It was rejected for mt-commerce because:

- The audience is broad. Many consumers are not the maintainers' team. They are agency developers, freelance integrators, plugin authors, and external systems. REST imposes a smaller learning cost on each of them.
- The integrations the platform must make are REST-shaped. Wrapping every external call in GraphQL adds a translation layer without a corresponding benefit.
- HTTP caching is a primary tool for storefront performance. GraphQL caching requires more coordination and yields less by default.
- The N+1 resolver problem is a recurring footgun. Avoiding it requires DataLoader patterns and per-resolver care that a small team has to maintain forever.
- Operational tooling for REST (logs, traces, dashboards, rate limiters, WAFs) works out of the box. GraphQL needs additional, GraphQL-specific tooling for the same coverage.

These are not arguments against GraphQL in general. They are arguments against it as the canonical surface for this specific platform and audience.

### tRPC

tRPC gives end-to-end type safety between a TypeScript client and a TypeScript server with very little ceremony. For internal applications where the same team owns both sides, it is excellent.

It was rejected because the API is a public surface meant for many consumers, including non-TypeScript ones. tRPC couples the client and server tightly through shared types and a transport that is not a documented HTTP contract. A public API needs a stable, language-agnostic contract; OpenAPI provides that, tRPC does not.

### gRPC

gRPC offers strong typing through Protocol Buffers and high performance for service-to-service calls. It was rejected because the audience and use cases are wrong:

- Browsers do not speak gRPC natively. The storefront would need gRPC-Web, an extra translation layer, and lose much of the benefit.
- Webhook providers and most third-party integrations speak HTTP+JSON, not gRPC.
- The tooling and developer-experience story for HTTP+JSON in the JavaScript and TypeScript ecosystems is much richer than for gRPC.

gRPC is a reasonable choice for internal microservice meshes. mt-commerce is a modular monolith ([ADR-0005](./0005-modular-monolith.md)) consumed mostly from browsers and external systems.

### A REST API with a GraphQL surface alongside

Running both surfaces was considered. It was rejected for the first releases because two surfaces double the maintenance burden, double the contract surface that breaks on changes, and split the documentation. It remains technically possible to add a GraphQL layer over the same internal services later if a real need appears — for example, a partner that requires it. The canonical API stays REST.

---

## Implementation notes

The following commitments follow directly from this decision:

- All routes live under versioned, audience-scoped prefixes: `/admin/v1/...` and `/storefront/v1/...`.
- Endpoints are resource-oriented. Standard HTTP verbs (`GET`, `POST`, `PATCH`, `DELETE`) carry their conventional meaning.
- Every request and response is validated by a Zod schema. The same schemas generate the OpenAPI document through `@hono/zod-openapi`.
- The OpenAPI document is the public contract. Breaking changes happen at major versions only; smaller changes are additive.
- Errors follow the shape documented in [`ARCHITECTURE.md`](../../ARCHITECTURE.md): `{ error: { code, message, details } }` with a stable error code.
- The SDK is generated against the OpenAPI document and is the canonical client for both the admin and the storefront.
- List endpoints support pagination, filtering, and sorting through query parameters with consistent names across resources.
- Endpoints that commonly need related data include those relations in the default response (for example, an order includes its line items) rather than requiring a follow-up call.
- Real-time data flows through outgoing webhooks signed with HMAC, as described in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the API conventions and error shape
- [ADR-0001](./0001-headless-architecture.md) — the headless decision that makes the API the product
- [ADR-0005](./0005-modular-monolith.md) — the internal shape behind the REST surface

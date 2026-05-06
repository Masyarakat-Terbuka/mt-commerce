# ADR-0005: Modular monolith over microservices

- **Status:** Accepted
- **Date:** 2026-05-07
- **Deciders:** mt-commerce maintainers

---

## Context

A commerce platform is a system with many distinct concerns: catalog, customers, carts, checkout, orders, payments, shipping, tax, promotions, notifications, webhooks, and authentication. As the system grows, the question arises: should each concern run as its own service, or should they all live in one application?

The two ends of the spectrum:

**Monolith** — one application, one deployable, everything imported together. Simple to build and operate. Risks turning into a tangled mess if module boundaries are not enforced.

**Microservices** — each concern as its own service, each with its own database, communicating over the network. Strong boundary enforcement. High operational complexity, network latency, distributed-systems failure modes, and coordination overhead.

A third pattern sits in the middle:

**Modular monolith** — one application, one deployable, but internally organized into clearly bounded modules. Modules talk through service interfaces, not direct imports of each other's internals. Each module owns its data. The architecture supports extracting a module into a separate service later if a real need emerges.

The choice has long-term consequences. It is much easier to start with a monolith and split it later than to start with microservices and combine them.

---

## Decision

mt-commerce is built as a **modular monolith**.

The API is a single application with internal modules: catalog, customer, cart, checkout, order, payment, shipping, tax, promotion, notification, auth, and webhook. Each module owns its tables, exposes a service interface, and does not reach into another module's internals.

We do not run microservices. We do not plan to.

---

## Consequences

### Positive

A small team can build and operate the system. There is one application to deploy, one set of dependencies to manage, one logging and tracing configuration, one CI pipeline.

Local development is straightforward. `docker compose up` brings the entire system to life. A new contributor can debug end-to-end in a single process.

Refactoring is safe. Type checking spans the whole system. Renames, restructurings, and interface changes happen across modules in a single commit, with the compiler catching mistakes.

Performance is honest. Cross-module calls are in-process function calls, not network hops. There is no service mesh, no retry logic, no circuit breaking.

Operational complexity is low. One application means one set of metrics, one health check, one set of secrets, one deployment process. Operators on a single small VPS can run mt-commerce comfortably.

The architecture is honest about scale. Most operators of mt-commerce will be small to mid-sized merchants for whom microservices are absurd overkill.

### Negative

Module boundaries must be enforced through discipline, not by network boundaries. A careless contributor could import another module's internals directly, and only review will catch it.

A truly massive deployment with thousands of orders per second per merchant might benefit from extracting hot-path modules. We accept that the project may need to evolve if it ever reaches that scale.

Some failure modes (a single bug taking down the whole system, a memory leak in one module starving others) are harder to isolate than they would be in microservices. We accept this trade-off in exchange for the operational simplicity.

A monolith is sometimes assumed to be unsophisticated, even when it is the right choice. Some contributors may arrive expecting microservices and need to understand the reasoning.

---

## Alternatives considered

### Microservices from day one

Splitting the API into a catalog service, an order service, a payment service, and so on was considered and rejected. The reasons:

- Microservices introduce distributed-systems concerns: network failures, partial failures, retries, idempotency across services, eventual consistency, and observability across service boundaries. These are real engineering problems that small teams cannot afford to solve from scratch.
- Each service needs its own deployment, its own database, its own monitoring, its own secrets, its own auth handling, and its own CI/CD pipeline. The operational tax compounds.
- Refactoring across services requires coordinated deployments, versioned APIs, and contract testing. What is a five-minute refactor in a monolith becomes a multi-week project in microservices.
- The promised benefits of microservices — independent scaling, technology diversity, team autonomy — are real, but they are solutions to problems that mt-commerce does not yet have.
- For the operators we serve, microservices on a single small VPS provide all of the costs of distributed systems and almost none of the benefits.

The microservices pattern is a tool for organizations with hundreds of engineers spread across many teams. mt-commerce is not that. It may never be that, and even if it becomes that, the decision can be made at that point.

### Pure monolith without explicit module boundaries

A monolith without module structure was rejected because it does not stay clean as the system grows. Without enforced boundaries, a feature in the order module starts importing helpers from the catalog module, then a query, then a database table directly. Over time, the system becomes a single tangled blob, and the cost of change rises until adding a feature requires understanding the entire codebase.

The modular monolith adds a small amount of upfront discipline (module boundaries, service interfaces) in exchange for keeping the system understandable as it grows.

### Distributed monolith (multiple services that share a database or are tightly coupled)

A distributed monolith — services that share a database or are coupled through synchronous calls — is the worst of both worlds. It has the operational complexity of microservices and the change-coupling of a monolith. It was rejected immediately.

---

## How module boundaries are enforced

Discipline is the primary mechanism, supported by tooling:

1. Each module lives in its own folder under `apps/api/src/modules/`.
2. Each module exposes its public interface through an `index.ts` that re-exports services, types, and events.
3. Modules import from each other only through these public interfaces, never reaching into internal files directly.
4. Each module owns its database tables. Other modules read or modify those tables only through the owning module's service.
5. Cross-module communication for non-blocking work happens through events on the typed event bus.
6. ESLint rules and pull request review enforce these conventions.

This is the same pattern used successfully in many medium-sized systems. It is not radical. It works.

---

## When extraction might happen later

Some future signals could justify extracting a specific module into its own service:

- A specific module receives so much load that scaling it independently would meaningfully reduce cost.
- A specific module has fundamentally different operational requirements (for example, a worker that must run on different hardware).
- A specific module has different release cadence requirements that the rest of the system cannot match.

When that happens, the module's clear interface and isolated data make extraction tractable. Until then, separating out a service preemptively is speculation.

---

## Related

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the shape of the system
- ADR-0001 — headless architecture (which is about external boundaries, not internal ones)

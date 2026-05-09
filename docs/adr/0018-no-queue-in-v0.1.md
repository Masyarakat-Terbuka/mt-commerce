# ADR-0018: No background-job queue in v0.1

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** mt-commerce maintainers

---

## Context

`ARCHITECTURE.md` (drafted at the start of the project) describes background jobs running on BullMQ, a Redis-backed queue, with a separate worker process. The implementation never landed for v0.1. This ADR records the decision to ship without a queue and explains the path from "deferred" to "deliberate."

The work that originally motivated the queue:

- Notifications fired from order events (`order.placed`, `payment.captured`)
- Webhook deliveries to operator-configured endpoints
- Catch-up sweeps for missed payment webhooks
- Future invoice / report generation

The mechanisms v0.1 actually uses for that work:

- A typed in-process event bus (`events.emit("order.placed", …)` / `events.on("order.placed", …)`) wired synchronously inside the request that produced the event. Notifications go out on the same Bun task as the order transition.
- A bulk reconciliation endpoint (`POST /admin/v1/payments/reconcile-pending`) the operator's host cron hits every few minutes to recover from missed webhooks.
- Provider-driven retries — Midtrans, Biteship, and the WhatsApp channel all retry their own callbacks on failure, so the inbound side already tolerates dropped attempts without a queue on our side.

Outgoing webhooks subscribed by operators (the "subscribe to `order.placed` from outside") are not in v0.1 at all.

A queue solves three problems: (1) deferring slow work off the request thread so the buyer's response is fast, (2) retrying failed work without losing it, (3) running cross-process work on a separate worker so the api can scale independently. We need to be honest about whether the v0.1 workload actually has any of those problems.

---

## Decision

v0.1 ships **without a queue**. Background-style work runs through one of two patterns:

**1. Synchronous event listeners.** Modules that want to react to other modules' events register on the typed event bus. Listeners run inline, on the same request that emitted the event, with their errors caught and logged so a failing listener does not roll back the originator. Notifications use this path; the WhatsApp send happens on the same request as the order transition.

**2. Operator-host cron.** Catch-up work — reconciling pending payments against the provider — runs as an authenticated `POST` to a bulk endpoint that the operator schedules with `cron`, `systemd timers`, or whatever their host already provides. The api is stateless about the schedule; the operator owns it.

The architecture document is updated to match: the BullMQ paragraph is replaced with a description of the synchronous + cron model, and the queue is moved to the "future" list with the threshold that would bring it back.

---

## Consequences

### Positive

The deployment story stays small. A v0.1 install is one Postgres, one Redis (used only for sessions and rate limits), and one api process. No worker process, no `BULLMQ_*` connection strings, no separate Procfile entry, no "did the worker get the job?" debugging path. An operator on a 2-vCPU VPS does not have to reason about which process does what.

The reconciliation pattern (ADR-driven by ADR-0012's payment provider interface) covers the failure mode the queue was supposed to handle. A missed webhook isn't dependent on a job retrying; the next cron tick polls the provider and applies the canonical state. The catch-up window is bounded by the cron interval (default 5 minutes) and is documented in the Midtrans plugin docs.

Synchronous event listeners are easy to test. A unit test that calls `await orderService.transition(...)` sees the notification go out as part of the same call. There is no harness for "wait for the queue to drain"; there is no flake from a slow worker.

The platform stays explicit about latency. A merchant looking at "why did the order page take 800ms?" sees the work that ran on that request. There is no hidden tail of queued work that affects throughput later.

### Negative

A slow side-effect blocks the response. If the WhatsApp channel takes 2s to send a message, the customer's checkout-confirmation request takes 2s plus the rest of the work. We mitigate this with timeouts on every external call and a circuit breaker for repeated failures, but the truth is: for v0.1's volume, the latency hit is acceptable; for v0.5's volume it may not be.

A failed listener loses its work. If the WhatsApp send throws, we log it and move on. The order transition has already committed; nothing replays the notification later. Operators see this as "I placed an order in the test, where's my message?" — and the answer is "check the logs and fire it manually." A queue would retry; we don't.

The reconciliation endpoint is operator-scheduled, which means it relies on the operator setting up cron correctly. A merchant who skips the cron step has a slow drift between platform state and Midtrans state until they hit the manual reconcile button. The deployment guide spells this out, and the admin UI surfaces "last reconciliation run" so missed schedules are visible. This is more friction than a self-scheduling queue would have.

We will pay a real migration cost when v0.5 or v1.0 brings the queue back. Listener registration changes from "register on the bus" to "enqueue and let the worker pick it up." We can keep the bus as a transport-agnostic façade so the call sites do not change, but the deployment topology, the operator's docs, and the failure modes do. We accept this; the cost of _not_ shipping v0.1 because we were waiting on the queue is higher.

The "outgoing webhooks to operator subscribers" feature stays in the future-pile. Operators who want to react to events outside the platform have no surface in v0.1. We tell them so up front in the docs.

---

## When to revisit

The queue comes back when one of these is true:

- A side-effect listener is regularly slower than 200ms p95 and that latency is shipping to user-facing requests. Today's listeners all stay well under that.
- A merchant runs into "we lost the WhatsApp send because the channel was down" frequently enough that the manual recovery is a real operational burden. Today's external services are reliable enough that this is theoretical.
- We add outgoing webhooks for operators. That surface needs retries, signing, and dead-letter — exactly the queue's strengths. We do not bolt webhooks onto a synchronous bus.
- The api needs to scale to multiple processes and a side-effect must run exactly once across them. The synchronous bus has no concept of "exactly once"; the queue does.

When any of these lands, the upgrade is to introduce BullMQ or an equivalent (Inngest, Trigger.dev, a Postgres-backed queue like Graphile Worker), not to expand the synchronous bus.

---

## What v0.1 does NOT have

- **A worker process.** Single api process, no separate runner.
- **Persistent retries.** Failed listeners are logged; nothing replays them.
- **Outgoing webhooks for operator subscribers.** External integrations cannot subscribe to platform events in v0.1.
- **Scheduled jobs the platform owns.** No "send a recovery email at 24h after cart abandonment" timer. The platform does not own a clock.
- **A dead-letter inspection UI.** There is nothing to inspect.

---

## Alternatives considered

### BullMQ on the Redis we already run

The original plan. BullMQ is the obvious choice for a Bun + Redis stack. We deferred it because:

- The v0.1 workload does not justify the operational footprint. Adding a worker process to the deployment guide costs more than the latency it saves on today's requests.
- The reconciliation pattern handles the only critical retry case. The queue's "did the work eventually run?" guarantee is not load-bearing for v0.1.
- Carrying BullMQ from day one would shape the api around it (every emitter would assume async-eventual delivery). Starting with the synchronous bus and graduating to a queue is the easier evolution; the reverse is harder.

### A Postgres-backed queue (Graphile Worker, pg-boss)

Same problem as BullMQ but without the Redis dependency. Considered briefly. Rejected for v0.1 because the operational cost of "we now have a worker process" is the same regardless of where the queue lives, and the Redis-backed queue has the better tooling story when we eventually need one.

This may be the right _future_ answer if a deployment wants to drop Redis. The queue interface is the seam.

### A serverless function platform (Inngest, Trigger.dev)

A managed external job runner. Rejected because it re-introduces the same external-dependency-on-the-critical-path problem the v0.1 deployment story is designed to avoid.

### A queue from day one, run in the same process

"BullMQ but on the same Bun process." Considered as a way to keep the deployment topology identical. Rejected because the value of a queue is partly the worker isolation; running it in the same process means a stuck listener still blocks the api. We get most of the cost without most of the benefit.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module boundaries; events on the bus respect them.
- [ADR-0012](./0012-payment-provider-interface.md) — the reconciliation pattern that backstops missed webhooks.
- [ADR-0014](./0014-notification-listeners.md) — notification dispatch is the heaviest synchronous listener.
- `apps/api/src/modules/payments/service.ts` — `reconcilePendingPayments` is the cron-driven catch-up.
- `apps/api/src/modules/payments/routes/admin.ts` — `POST /admin/v1/payments/reconcile-pending` is the cron target.

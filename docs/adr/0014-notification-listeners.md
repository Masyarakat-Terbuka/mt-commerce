# ADR-0014: Notification listeners and event-level idempotency

- **Status:** Accepted
- **Date:** 2026-05-08
- **Deciders:** mt-commerce maintainers

---

## Context

When an order is placed, a customer should receive an order-confirmation email. When a payment is captured, a payment-received email. When a fulfillment ships, a shipping-update email. The platform has the data and the channels; the question is who decides to send.

Two patterns exist:

**Emit-from-source.** Each originating module — orders, payments, shipping — calls `notificationService.send(...)` directly when it transitions. The orders service writes the order, then sends the email. The payments service writes the capture, then sends the email. The shipping service writes the fulfillment, then sends the email.

**Listen-from-side.** The originating modules emit typed events on an in-process bus. The notification module subscribes to the events it cares about and sends from there. Originating modules do not import the notification service.

A second concern is delivery semantics. The bus is fire-and-forget within a single api process — a listener throw cannot rollback the upstream commit. But events can be delivered more than once: a webhook upstream may retry, a future worker process may re-deliver, an operator may replay an event for debugging. The platform must not email a customer twice for the same underlying fact.

A third concern is what to do about failed dispatches. When SMTP rejects a send, the row could be deleted, retried, or recorded as-is.

---

## Decision

The notification module **listens** for the events that drive customer messaging and sends from there. The originating modules know nothing about notifications.

Three subscriptions live in `apps/api/src/modules/notification/service.ts`:

- `order.placed` → `order_confirmation` email (and best-effort WhatsApp when configured).
- `payment.captured` → `payment_received` email.
- `fulfillment.shipped` → `shipping_update` email.

Idempotency is enforced at the database. The `notifications` table has an `event_id` column and a partial unique index `(event_id, kind, channel) WHERE event_id IS NOT NULL`. Listeners derive `event_id` deterministically from the event payload (`event:order.placed:ord_abc`). A duplicate insert raises `23505`; the service catches it, looks up the existing row, and returns it without dispatching to the channel a second time.

Failed dispatches are **recorded as rows** with `status='failed'` and the error message. There is no retry queue and no automatic re-send.

---

## Consequences

### Positive

The listener pattern keeps the orders, payments, and shipping services free of any notification concerns. They emit a fact; what reacts to that fact is wired separately. A future plugin that wants to push order confirmations into a CRM subscribes to the same `order.placed` event and lives next to the notification module's listeners — neither plugin nor the originating service needs to know about the other.

The originating modules stay testable without a notification fake. Tests that exercise "the orders service materialises an order" do not have to stub out an email send; the event bus has nothing subscribed and the test is the same shape as a production listener that happens to be absent.

The `event_id`-keyed unique index makes idempotency a database-level fact. The application catches the constraint violation and returns the existing row — there is no application-level "have we sent this?" lookup that could race a concurrent insert. The triple `(event_id, kind, channel)` is the right grain because the same event may legitimately fan out to two rows of different kinds (an `order.placed` could in future drive both `order_confirmation` email and an SMS) or two channels (email + WhatsApp), each of which is a separately-meaningful "have we sent this?".

The partial-on-not-null shape leaves non-event sends (`email_verification`, `password_reset`) free to write multiple rows. A customer can request a fresh verification email after the first one bounced; that path has no `event_id` and the index does not apply.

Recording failed dispatches as rows, rather than throwing them away or auto-retrying, gives operators an honest record of what the platform tried to do. The admin notification grid filters by `status='failed'` and surfaces the error message; an operator can manually re-trigger or investigate the upstream cause. A naive retry queue would paper over real configuration problems (a misconfigured SMTP host, an expired API key) and produce duplicate sends if it succeeds after the operator manually resent.

### Negative

A bug in a listener body cannot fail the originating commit. If `dispatchOrderConfirmation` throws because the customer service is briefly unavailable, the order is still placed and the email is silently absent. The listener is wrapped in a try/catch that logs at error level, so the operator has a grep target — but the customer does not get the email. We accept this in v0.1 because the alternative (linking the email send to the order commit) would mean a dead email channel could prevent orders from being placed, which is the wrong trade.

There is no retry. A transient SMTP failure produces a `failed` row and stays that way unless an operator does something about it. v0.1 ships without a worker, and a retry loop in-process is the kind of thing that breaks at 3 a.m. when the SMTP host is down — we'd rather have an honest record than a queue we can't see.

The lazy resolution of order/customer services inside listeners (via dynamic import) is a code-shape concession to a real cycle: the auth module imports the notification service at module-evaluation time for its verification-email path, and the auth middleware is reachable from the orders/customer route builders. Eagerly importing those services from the notification module's constructor would close the cycle. Lazy resolution avoids it without runtime cost (the resolver caches), but it is a non-obvious shape and merits the comment in the code.

---

## What this module does NOT do

- **Retry failed dispatches.** A failed row stays failed.
- **Schedule sends.** Notifications go out as soon as the listener fires.
- **Fan out to a queue or worker.** The listener body runs in-process, in the same Node thread as the request that produced the event.
- **Track delivery confirmation.** A `sent` status means "the channel adapter accepted the call without throwing." Whether the customer's mailbox actually received the message is not modelled.
- **Throttle per-recipient.** A bug that fires `order.placed` twice for the same order would be caught by the unique index, but the same recipient receiving 100 different `order_confirmation` emails because they placed 100 orders is treated as legitimate.

---

## Alternatives considered

### Emit from the originating module

Having the orders service call `notificationService.send(...)` directly is the simplest shape. It was rejected because:

- It makes the orders service's tests depend on a notification fake.
- It puts customer-messaging policy ("which kinds of events trigger which kinds of emails") inside services that should be agnostic to it. Today an order placed by a guest gets the same email as an order placed by an account holder; tomorrow the policy might branch — and the branch should live next to the templates, not inside the orders service.
- Plugin extension is awkward: a plugin that wants to react to `order.placed` would either have to subscribe to the event bus anyway (in which case the originating module also subscribes, which is asymmetric) or import a registry that the orders service consults.

### Application-level idempotency lookup before insert

A `select ... where event_id = ?` before the insert would work for the single-process happy case but races a concurrent listener. The unique index is the only way to guarantee at-most-once across concurrent inserts; the application catch is just the recovery path for the loser of the race. Rejected as insufficient.

### A retry queue

A real retry queue with exponential backoff is in scope for a future worker process. v0.1 has no worker, so the only place to put a retry loop is in-process — which means the loop is gone on a process restart, and a long retry can pin a request thread. Either failure mode is worse than the operator-visible `failed` row that v0.1 produces. Rejected for v0.1; reconsidered when a worker exists.

### Synchronous send inside the originating transaction

Sending the email inside the database transaction that places the order would let a SMTP failure rollback the order, guaranteeing "if you got the email, the order exists." It was rejected because the failure mode is wrong: a flaky SMTP host would prevent orders from being placed. The reverse — order exists without email — is recoverable; the customer can be re-notified. The forward — email without order — is impossible by construction. Rejected.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module ownership and the in-process event bus.
- `apps/api/src/modules/notification/` — the service and listeners.
- `apps/api/src/db/schema/notifications.ts` — the table including `event_id`.
- `apps/api/drizzle/migrations/0015_notifications_event_id.sql` — the partial unique index.

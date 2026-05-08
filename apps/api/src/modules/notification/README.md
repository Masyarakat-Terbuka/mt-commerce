# Notification module

Owns outbound notifications and the audit log of every send attempt.
Per ADR-0005, no other module reads or writes `notifications` directly —
cross-module callers go through `notificationService`.

## Channels

The module ships three channel adapters:

| Channel id | Adapter                | Purpose                                            |
| ---------- | ---------------------- | -------------------------------------------------- |
| `email`    | `SmtpEmailChannel`     | Production email via nodemailer + SMTP             |
| `email`    | `ConsoleEmailChannel`  | Dev/test fallback that logs the message            |
| `whatsapp` | `WhatsappStubChannel`  | Stub; throws until the WhatsApp plugin is installed |

The default registry resolves `email` to either the SMTP adapter or the
console fallback based on `NOTIFICATION_DEFAULT_CHANNEL` (defaults to
`smtp` in production, `console` elsewhere). The SMTP factory itself
falls back to console when `SMTP_HOST` is missing outside production;
**in production the SMTP adapter throws on construction** if the host is
unset, so the API refuses to start without explicit configuration.

Plugin authors add a new channel by implementing `NotificationChannel`
from `channels/types.ts` and registering the instance in their plugin's
manifest (the plugin loader will surface a registration hook in v0.2).

## Templates

Pure render functions in `templates/index.ts`. Each kind takes its
typed payload + an optional locale (`'id' | 'en'`, default `id`) and
returns `{ subject, body, htmlBody }`:

| Kind                  | Used by                                            |
| --------------------- | -------------------------------------------------- |
| `email_verification`  | Auth's `sendVerificationEmail`                     |
| `order_confirmation`  | Future `order.placed` listener                     |
| `payment_received`    | Future `payment.captured` listener                 |
| `shipping_update`     | Future `fulfillment.shipped` listener              |
| `password_reset`      | Auth's password-reset flow                         |

Voice: calm, factual, Bahasa-first. Subject lines are direct
("Pesanan Anda telah diterima — #ORD-..."). Bodies are functional. No
marketing flourishes.

## Audit log

Every `send(...)` call writes a `notifications` row at `status='pending'`
BEFORE the channel is invoked, then updates to `sent` (or `failed` with
`error_message`) after the adapter settles. The audit row is the system
of record for "did we send it" — the channel's own logs are best-effort.

The admin route at `GET /admin/v1/notifications` reads this log
(role: `owner | admin | staff`).

## Send semantics

Two public methods on the service:

- `send(input)` — fire-and-forget. Never throws on a channel failure;
  inspect `result.notification.status` to branch. Used by the event-
  listener path where surfacing the failure to an HTTP caller does not
  apply.

- `sendOrThrow(input)` — request-path variant. Re-throws on channel
  failure so a caller (auth's `sendVerificationEmail`) can fail the
  originating HTTP request rather than silently succeed. The audit row
  is persisted in either branch.

## Event wiring

`subscribeToEvents()` is called once from `app.ts` after construction.
The notification module subscribes to three cross-module events:

| Event                  | Bus              | Template             | Channels                                            |
| ---------------------- | ---------------- | -------------------- | --------------------------------------------------- |
| `order.placed`         | orders           | `order_confirmation` | email, plus WhatsApp best-effort if a non-stub channel is registered and the customer has a phone |
| `payment.captured`     | payments         | `payment_received`   | email                                               |
| `fulfillment.shipped`  | shipping         | `shipping_update`    | email                                               |

Each event payload carries IDs only — the listener loads the full order
through `orderService.getOrderById` to render line items, totals, and
the shipping address. Customer contact + locale come from
`customerService.getCustomerById` when the order has a `customerId`;
guest checkouts (`customerId === null`) fall back to the order's
`email` and the shipping-address phone.

`checkout.completed` remains as a debug-level no-op subscriber so an
operator searching for the event in code finds the explicit decision
("the orders module emits the canonical placed event").

### Cross-module dependency wiring

The notification module is reached at module-evaluation time by the auth
module (`auth/better-auth.ts` resolves `getNotificationService` for the
verification-email path). To avoid closing a cycle through the
shipping/customer route builders → auth middleware → notification, the
service resolves `orderService` / `customerService` LAZILY (dynamic
import) on the first listener invocation. Tests inject concrete fakes
through the constructor and skip the dynamic import entirely.

## Idempotency

The `notifications` table carries an `event_id` column with a partial
unique index on `(event_id, kind, channel) WHERE event_id IS NOT NULL`.
Event-driven sends pass a deterministic id of the form
`event:<event-name>:<primary-id>` (e.g. `event:order.placed:ord_abc`),
so a duplicate event delivery hits the index and the second insert
raises 23505. The service catches that, looks up the existing row, and
returns it without dispatching to the channel a second time.

This is the at-least-once guard for the event-listener path. Rationale
for the partial-unique-index choice over a service-level pre-check:

- A pre-check has a TOCTOU window between the SELECT and the INSERT;
  two concurrent listener invocations can both see "no row" and both
  insert. The partial unique index is the only race-free guarantee.
- Non-event sends (`email_verification`, `password_reset`) write rows
  with `event_id = NULL` and remain free to send the same kind to the
  same recipient repeatedly (a customer can request a second
  verification email).

## Channel-failure handling

Channel dispatch can throw (SMTP unreachable, WhatsApp template
unapproved). The listener wrapper:

- Logs the failure at warn/error level with the event name and IDs.
- Records a `failed` notification row via `markStatus`.
- Does NOT crash the order/payment/shipping flow — the upstream domain
  operation already committed before the event fired, and the bus
  swallows per-listener exceptions.

No retry queue in v0.1 — failed notifications are surfaced through the
admin endpoint at `GET /admin/v1/notifications`.

## Tables

`notifications` (audit log):

| Column          | Type            | Notes                                          |
| --------------- | --------------- | ---------------------------------------------- |
| `id`            | text PK         | ULID, prefix `notif_`                          |
| `channel`       | text NOT NULL   | `'email' \| 'whatsapp'`                        |
| `kind`          | text NOT NULL   | One of the kinds above                         |
| `recipient`     | text NOT NULL   | Email address or phone number                  |
| `subject`       | text NULL       | Channels without subjects (WhatsApp) leave it null |
| `payload`       | jsonb NOT NULL  | Template variables — NOT the rendered body     |
| `status`        | text NOT NULL   | `'pending' \| 'sent' \| 'failed'`              |
| `error_message` | text NULL       | Set when `status='failed'`                     |
| `event_id`      | text NULL       | Deterministic key for event-driven sends; null for non-event sends. See "Idempotency" above. |
| `created_at`    | timestamptz     | Indexed; admin recent-list and TTL sweep       |
| `updated_at`    | timestamptz     |                                                |

Indexes:
- `created_at`
- `(channel, status)`
- `(event_id, kind, channel)` UNIQUE WHERE `event_id IS NOT NULL` — see "Idempotency".

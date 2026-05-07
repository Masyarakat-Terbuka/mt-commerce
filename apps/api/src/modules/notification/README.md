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
v0.1 wires:

- `checkout.completed` — currently a logging-only listener; Track 3's
  Order module emits a richer `order.placed` event with the resolved
  recipient and items, which this listener will pick up.

Future events that emit notifications:

- `payment.captured` → `payment_received`
- `fulfillment.shipped` → `shipping_update`

These are TODO-flagged in `service.ts` so the wiring goes in alongside
the emitting module.

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
| `created_at`    | timestamptz     | Indexed; admin recent-list and TTL sweep       |
| `updated_at`    | timestamptz     |                                                |

Indexes: `created_at`, `(channel, status)`.

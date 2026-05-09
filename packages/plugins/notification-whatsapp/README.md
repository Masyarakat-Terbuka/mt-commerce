# @mt-commerce/plugin-notification-whatsapp

Real WhatsApp delivery for mt-commerce. Replaces the v0.1 in-tree
`whatsapp` stub channel (which throws on every send) with an adapter
backed by the Meta WhatsApp Business Cloud API.

Once registered, the notification service's `order.placed`,
`payment.captured`, and `fulfillment.shipped` listeners route customer
pings through WhatsApp for any order whose customer (or shipping address)
carries a phone number — alongside the email path.

## What it does

- Registers a notification channel with id `whatsapp` that POSTs to
  `https://graph.facebook.com/v20.0/{phoneNumberId}/messages` using the
  `template` message type.
- Maps each supported notification kind (`order_confirmation`,
  `payment_received`, `shipping_update`) to a Meta-approved template,
  with a small per-kind mapper that fills the template's positional body
  variables.
- Normalises Indonesian phone numbers to the WhatsApp wire shape
  (`628123456789` — no `+`, no separators) before dispatch. Both the
  national trunk form (`08...`) and already-international forms work.
- Surfaces upstream rejections as `ChannelDispatchError` carrying the
  parsed Meta error envelope (`{ error: { message, code, ... } }`) so
  audit-row failures are diagnosable from logs alone.

## Prerequisites

1. A Meta Business Manager account with a verified business and an
   approved WhatsApp Business Account.
2. A verified phone number on that WABA, with a permanent access token
   (system user token recommended over the temporary 24-hour token).
3. Three templates approved in the Meta dashboard, with the variable
   counts and order documented below.

## Configuration

```ts
// mt-commerce.config.ts
import { defineConfig } from "@mt-commerce/core/plugin";
import whatsappPlugin from "@mt-commerce/plugin-notification-whatsapp";

export default defineConfig({
  plugins: [
    whatsappPlugin({
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
      language: "id",
      templates: {
        order_confirmation: "order_confirmation_id",
        payment_received: "payment_received_id",
        shipping_update: "shipping_update_id",
      },
    }),
  ],
});
```

### Environment variables (operator-facing)

| Variable                   | Required | What it is                                                     |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `WHATSAPP_PHONE_NUMBER_ID` | yes      | The phone number id from the Meta WhatsApp Business dashboard. |
| `WHATSAPP_ACCESS_TOKEN`    | yes      | A permanent (system user) WhatsApp Business API access token.  |

The plugin itself reads neither — operators wire them through the config
file. Pulling them from env vars is the recommended pattern so secrets
do not land in source control.

## Templates the operator must register

All three templates use the BODY component with positional text
parameters. Submit them in the Meta dashboard under
`Account Tools → Message Templates`. Approval typically takes a few
hours; the plugin will surface a `ChannelDispatchError` with
`code=132001` ("template name does not exist in the translation") until
approval lands.

### `order_confirmation_id` — 3 variables

A short order-receipt ping that confirms the order id, the total, and
the item count. The full line breakdown stays in the email; WhatsApp's
approved template body is constrained to a single glance-sized message.

| Variable | Example          | Source                         |
| -------- | ---------------- | ------------------------------ |
| `{{1}}`  | `MT-2025-000123` | order number (customer-facing) |
| `{{2}}`  | `Rp 670.000`     | total, formatted               |
| `{{3}}`  | `3 barang`       | item count + locale label      |

Indonesian sample body:

```
Halo, pesanan {{1}} sudah kami terima. Total: {{2}} ({{3}}). Kami akan kabari kembali begitu pembayaran masuk.
```

### `payment_received_id` — 3 variables

| Variable | Example           | Source            |
| -------- | ----------------- | ----------------- |
| `{{1}}`  | `MT-2025-000123`  | order number      |
| `{{2}}`  | `Rp 670.000`      | amount, formatted |
| `{{3}}`  | `manual_transfer` | payment method    |

Indonesian sample body:

```
Pembayaran {{2}} untuk pesanan {{1}} ({{3}}) sudah kami terima. Pesanan akan segera kami proses.
```

### `shipping_update_id` — 3 variables

| Variable | Example          | Source                                         |
| -------- | ---------------- | ---------------------------------------------- |
| `{{1}}`  | `MT-2025-000123` | order number                                   |
| `{{2}}`  | `Dikirim`        | localised status (`Dikirim` / `Shipped`, etc.) |
| `{{3}}`  | `JX-998877`      | tracking code (or `-` when none)               |

Indonesian sample body:

```
Pesanan {{1}} berstatus {{2}}. Kode resi: {{3}}.
```

## Behaviour notes

- **Idempotency**: handled by the notification service via the partial
  unique index on `(event_id, kind, channel)`. The channel does not
  retry, does not dedupe, does not inspect the audit log.
- **Phone source**: the service prefers the customer's stored phone over
  the shipping address phone. Guest checkouts fall back to the shipping
  address phone. A customer with no phone on either record skips the
  WhatsApp dispatch silently.
- **No email fallback in-channel**: a missing template entry throws
  `UnsupportedKindError`. The notification service marks the audit row
  failed; the email path continues to fire because email and WhatsApp
  are dispatched independently from the same listener.

## Verifying locally

The unit tests are pure and run with `bun --filter @mt-commerce/plugin-notification-whatsapp test`. They use a fake `fetch` and never touch the network.

To smoke-test against the live Meta API, set the gating env vars and
re-run the suite:

```bash
export WHATSAPP_PHONE_NUMBER_ID=...
export WHATSAPP_ACCESS_TOKEN=...
export WHATSAPP_TEST_RECIPIENT=+62812...   # your own WhatsApp number
# optional — override template names if you registered them under different ids
export WHATSAPP_TEMPLATE_ORDER_CONFIRMATION=order_confirmation_id
bun --filter @mt-commerce/plugin-notification-whatsapp test
```

The live suite sends one message to the configured recipient. Use a
phone number you own; Meta charges per conversation and rate-limits
unknown recipients.

## Reference

For the plugin authoring contract, see the
[plugin author guide](https://github.com/masyarakat-terbuka/mt-commerce/blob/main/apps/docs/src/content/docs/plugins/author-guide.mdx)
on the docs site. For the notification module's channel/service contract,
see
[`apps/api/src/modules/notification/channels/types.ts`](../../../apps/api/src/modules/notification/channels/types.ts).

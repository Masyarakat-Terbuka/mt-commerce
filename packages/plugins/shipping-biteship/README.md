# @mt-commerce/plugin-shipping-biteship

Biteship shipping integration for mt-commerce.

[Biteship](https://biteship.com) is an Indonesian shipping aggregator
that exposes a single API on top of JNE, J&T, SiCepat, AnterAja, Gojek,
Grab, Pos Indonesia, Ninja Xpress, and others. This plugin gives an
mt-commerce store live rate quoting, order creation, and tracking
webhooks against Biteship.

## What this plugin does

- Registers a `ShippingProvider` (code `"biteship"`) that quotes through
  `/v1/rates/couriers` and creates orders through `/v1/orders`.
- Exposes a webhook verification + event mapper the api's webhook route
  layer drives. Biteship tracking events map to `fulfillment.shipped`
  (on `picked_up`, `in_transit`, etc.) and `fulfillment.delivered` (on
  `delivered`).
- Supports cash-on-delivery: pass `cod: true` at quote time to filter
  the rate ladder to COD-capable couriers, and pass `cod: true` +
  `codAmount` at order creation time so Biteship instructs the courier
  to collect cash.
- Ships a default seed list of common courier services (`JNE_REG`,
  `JNT_EZ`, `SICEPAT_BEST`, `GOJEK_INSTANT`, ...) for the operator-run
  shipping-methods seeding step.

## Supported couriers (default)

`jne`, `jnt`, `sicepat`, `anteraja`, `gojek`, `grab`. Others are
available — pass `couriers: [...]` to enable them. The default set
covers the major nationwide and same-day options Indonesian merchants
typically enable first.

## Get a Biteship API key

1. Sign up at [biteship.com](https://biteship.com).
2. Go to **Dashboard → Account → API**.
3. Copy the **test** key (`test_*`) for sandbox and the **live** key
   (`live_*`) for production.

The same plugin handles both — the `mode` option selects which.

## Install

```bash
bun add @mt-commerce/plugin-shipping-biteship
```

(In the mt-commerce monorepo this package is wired through workspaces
and does not need to be installed separately.)

## Configure

Wire the plugin in `mt-commerce.config.ts`:

```ts
import { defineConfig } from "@mt-commerce/core/plugin";
import biteshipPlugin from "@mt-commerce/plugin-shipping-biteship";

export default defineConfig({
  plugins: [
    biteshipPlugin({
      apiKey: process.env.BITESHIP_API_KEY!,
      mode: "production", // or "sandbox" (default)
      origin: {
        postalCode: "12345",
        contactName: "Toko ABC",
        contactPhone: "+6281234567890",
        address: "Jl. Mawar No. 1, Jakarta",
      },
      couriers: ["jne", "jnt", "sicepat", "anteraja", "gojek", "grab"],
      webhookSecret: process.env.BITESHIP_WEBHOOK_SECRET,
    }),
  ],
});
```

### Environment variables

| Variable                     | Required | Purpose                                              |
| ---------------------------- | -------- | ---------------------------------------------------- |
| `BITESHIP_API_KEY`           | yes      | Biteship API key (`test_*` or `live_*`).             |
| `BITESHIP_WEBHOOK_SECRET`    | for webhooks | HMAC-SHA256 secret operators paste from the dashboard. |
| `BITESHIP_SANDBOX_API_KEY`   | tests only | Enables the gated sandbox tests in this package. |

## Seed shipping methods

For v0.1 the plugin does NOT auto-mutate `shipping_methods` at boot.
Operators run a one-shot script that POSTs each row through the admin
shipping API. The plugin exports a default seed list:

```ts
import { defaultBiteshipMethodSeeds } from "@mt-commerce/plugin-shipping-biteship";

for (const seed of defaultBiteshipMethodSeeds) {
  await adminApi.shipping.createMethod({
    code: seed.code,
    name: seed.name,
    providerKind: "plugin",
  });
}
```

The default list covers `JNE_REG`, `JNE_OKE`, `JNE_YES`, `JNT_EZ`,
`SICEPAT_REG`, `SICEPAT_BEST`, `ANTERAJA_REG`, `GOJEK_INSTANT`, and
`GRAB_INSTANT`. Operators can pass their own array via the plugin's
`methodSeeds` option to override.

## Webhook URL

Register the webhook in your Biteship dashboard under
**Dashboard → Webhooks**. The URL should point at the api's Biteship
webhook route, e.g.:

```
https://yourstore.example.com/api/webhooks/shipping/biteship
```

The route layer must:

1. Read the raw body (do not let the framework parse it before HMAC
   verification — Biteship signs the bytes you receive).
2. Call `verifyWebhook({ rawBody, headers, secret })`. Respond `401`
   on any non-`ok: true` result.
3. Call `parseWebhook(rawBody)` to get the normalized event.
4. If `event.kind === "fulfillment.shipped"`, call
   `shippingService.markShipped(...)` for the fulfillment that
   matches `event.providerRef` (the Biteship order id you stored on the
   row at `createOrder` time).
5. If `event.kind === "fulfillment.delivered"`, call
   `shippingService.markDelivered(...)` similarly.
6. If `event.kind === "ignored"`, respond `200` without dispatching —
   Biteship retries on non-2xx, so silently ignoring noise statuses is
   the correct behavior.

The webhook URL must be reachable over HTTPS. Biteship signs requests
with HMAC-SHA256 of the raw body; the digest arrives in the
`x-biteship-signature` header (hex-encoded).

## Testing

Mock-based tests run by default:

```bash
bun --filter @mt-commerce/plugin-shipping-biteship test
```

Real-sandbox tests are gated by `BITESHIP_SANDBOX_API_KEY` and skipped
otherwise:

```bash
BITESHIP_SANDBOX_API_KEY=test_xxx \
BITESHIP_SANDBOX_ORIGIN_POSTAL=12345 \
BITESHIP_SANDBOX_DEST_POSTAL=67890 \
bun --filter @mt-commerce/plugin-shipping-biteship test
```

## Reference

- [Biteship API docs](https://biteship.com/id/docs)
- [`docs/plugins/author-guide.md`](../../../docs/plugins/author-guide.md)
- [`packages/core/src/plugin.ts`](../../core/src/plugin.ts) — the
  `ShippingProvider` interface this plugin implements.

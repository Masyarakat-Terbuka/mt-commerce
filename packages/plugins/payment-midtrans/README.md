# @mt-commerce/plugin-payment-midtrans

Midtrans payment provider for mt-commerce. Uses Midtrans Snap (hosted
checkout) for the buyer flow and the Midtrans Core API for refunds.

## What this plugin does

- Registers a `PaymentProvider` with code `midtrans` against the
  mt-commerce plugin loader.
- On `initiate`, requests a Snap transaction token and returns the
  Snap redirect URL the storefront sends the buyer to.
- On `refund`, posts to the Midtrans Core API
  `/v2/{paymentId}/refund` endpoint, using the platform's idempotency
  key as Midtrans's `refund_key` so retries are no-ops on Midtrans's
  side.
- On webhook delivery, verifies the `signature_key` field per the
  Midtrans documented formula
  (`SHA512(order_id + status_code + gross_amount + serverKey)`) before
  the platform parses or trusts any field of the body.
- `capture` is a structured no-op — Snap auto-captures for the
  channels enabled below. Card pre-authorise is out of scope for v0.1.

## Payment methods enabled by default

| Channel       | Snap code     | Notes                                  |
| ------------- | ------------- | -------------------------------------- |
| QRIS          | `qris`        | Universal QR. Works for any e-wallet.  |
| GoPay         | `gopay`       |                                        |
| ShopeePay     | `shopeepay`   |                                        |
| BCA VA        | `bca_va`      | Virtual account                        |
| BNI VA        | `bni_va`      | Virtual account                        |
| BRI VA        | `bri_va`      | Virtual account                        |
| Permata VA    | `permata_va`  | Virtual account                        |
| Mandiri Bill  | `echannel`    | Mandiri Bill Payment (Snap channel)    |
| Credit card   | `credit_card` | 3DS enabled by default                 |
| Indomaret     | `indomaret`   | Over-the-counter cash                  |
| Alfamart      | `alfamart`    | Over-the-counter cash                  |

DANA and OVO are not in the default set: DANA is enabled via the
QRIS rail (any DANA wallet can scan a QRIS), and OVO has been
removed from Snap as a standalone channel by Midtrans. Operators
can supply a custom set per transaction via
`metadata.enabledPayments` at intent creation time.

## Setup

### 1. Register a Midtrans account

Sign up at <https://dashboard.midtrans.com/register> and grab the
sandbox keys from **Settings → Access Keys**. You will see two keys:

- **Server Key** — secret. Goes into `MIDTRANS_SERVER_KEY`.
- **Client Key** — public. Goes into `MIDTRANS_CLIENT_KEY`.

For production keys, complete the Midtrans verification process
inside the dashboard, then switch the `mode` option below to
`"production"`.

### 2. Wire the plugin in `mt-commerce.config.ts`

```ts
import { defineConfig } from "@mt-commerce/core/plugin";
import midtransPlugin from "@mt-commerce/plugin-payment-midtrans";

export default defineConfig({
  plugins: [
    midtransPlugin({
      serverKey: process.env.MIDTRANS_SERVER_KEY ?? "",
      clientKey: process.env.MIDTRANS_CLIENT_KEY ?? "",
      mode: process.env.MIDTRANS_MODE === "production"
        ? "production"
        : "sandbox",
      finishUrl:  "https://shop.example.id/checkout/selesai",
      pendingUrl: "https://shop.example.id/checkout/menunggu",
      errorUrl:   "https://shop.example.id/checkout/gagal",
    }),
  ],
});
```

### 3. Environment variables

| Variable                | Required | Notes                                  |
| ----------------------- | -------- | -------------------------------------- |
| `MIDTRANS_SERVER_KEY`   | yes      | From the Midtrans dashboard.           |
| `MIDTRANS_CLIENT_KEY`   | yes      | Public; loaded into the storefront.    |
| `MIDTRANS_MODE`         | no       | `sandbox` (default) or `production`.   |

### 4. Webhook URL

Register the following URL on the Midtrans dashboard at
**Settings → Configuration → Payment Notification URL**:

```
https://<your-api-host>/webhooks/payments/midtrans
```

Midtrans will POST every transaction status change (settlement,
expire, cancel, refund) to that URL. The platform's webhook
handler:

1. Calls this plugin's `verifyWebhookSignature` to verify the
   `signature_key` field.
2. Looks up the payment row by `(provider, providerRef)` (the Snap
   `order_id`, which the plugin sets to the platform's payment id).
3. Transitions the payment + order accordingly.

## Reconciliation

Midtrans may deliver `settlement` notifications with a long delay
for VA and over-the-counter cash payments — the buyer can pay an
hour, a day, or up to seven days after the Snap redirect. The
platform's webhook handler is **idempotent on duplicate delivery**:
re-receiving the same `settlement` event for an already-`captured`
payment writes a fresh attempt row but does NOT re-transition the
payment or the order. See ADR-0010 (the payments module) for the
canonical idempotency contract.

## Sandbox integration test (skipped by default)

Unit tests stub `fetch` and never hit the network. To exercise the
real Midtrans sandbox:

```bash
export MIDTRANS_SANDBOX_SERVER_KEY="SB-Mid-server-..."
export MIDTRANS_SANDBOX_CLIENT_KEY="SB-Mid-client-..."
bun test
```

The sandbox test (when present) lives at
`tests/sandbox.integration.test.ts` and is gated by
`describe.skipIf(!process.env.MIDTRANS_SANDBOX_SERVER_KEY)`. It
issues a real Snap `/transactions` POST against
`https://app.sandbox.midtrans.com` and asserts that the response
carries a `token` and a `redirect_url`. It does NOT issue refunds
(which would create real sandbox state), nor does it simulate a
buyer paying — those flows require the Midtrans simulator UI.

## Testing your wiring locally

1. Run the sandbox sample storefront and admin:
   `bun --filter '*' dev`
2. Place an order through the storefront against `provider: "midtrans"`.
3. The api will log:
   `plugin @mt-commerce/plugin-payment-midtrans@0.1.0 loaded`.
4. Initiate the payment; the response carries a `redirectUrl`. Open
   it in a browser, pay through the Midtrans simulator, and watch
   the api logs for the inbound webhook.
5. Confirm the `payments.<id>` row transitions to `captured` and
   the order moves to `paid`.

## Reference

- mt-commerce plugin author guide:
  [`docs/plugins/author-guide.md`](../../../docs/plugins/author-guide.md).
- Midtrans Snap API reference:
  <https://docs.midtrans.com/docs/snap-api-overview-snap>.
- Midtrans webhook signature reference:
  <https://docs.midtrans.com/docs/https-notification-webhooks>.

## License

MIT — see the repository's [LICENSE](../../../LICENSE).

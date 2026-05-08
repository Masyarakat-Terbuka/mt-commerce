/**
 * `@mt-commerce/plugin-payment-midtrans` — Midtrans payment provider for
 * mt-commerce.
 *
 * What this plugin does:
 *
 *   - Registers a `PaymentProvider` with code `"midtrans"` against the
 *     mt-commerce plugin loader.
 *   - Talks to Midtrans Snap (hosted checkout) for `initiate`, the Core
 *     API for `refund`, and verifies inbound webhooks via SHA512 of
 *     `order_id + status_code + gross_amount + serverKey`.
 *   - Enables QRIS, GoPay, ShopeePay, virtual accounts (BCA, BNI, BRI,
 *     Permata, Mandiri/echannel), credit card, and Indomaret/Alfamart by
 *     default. Operators can override per-transaction by passing
 *     `metadata.enabledPayments` at intent-creation time.
 *
 * Operator wiring (`mt-commerce.config.ts`):
 *
 *   import { defineConfig } from "@mt-commerce/core/plugin";
 *   import midtransPlugin from "@mt-commerce/plugin-payment-midtrans";
 *
 *   export default defineConfig({
 *     plugins: [
 *       midtransPlugin({
 *         serverKey: process.env.MIDTRANS_SERVER_KEY ?? "",
 *         clientKey: process.env.MIDTRANS_CLIENT_KEY ?? "",
 *         mode: process.env.MIDTRANS_MODE === "production" ? "production" : "sandbox",
 *         finishUrl: "https://shop.example.id/checkout/selesai",
 *         pendingUrl: "https://shop.example.id/checkout/menunggu",
 *         errorUrl: "https://shop.example.id/checkout/gagal",
 *       }),
 *     ],
 *   });
 *
 * Webhook URL operators register on the Midtrans dashboard:
 *
 *   https://<your-api-host>/webhooks/payments/midtrans
 *
 * The platform's webhook handler is idempotent on duplicate delivery —
 * Midtrans will redeliver `settlement` notifications for delayed VA /
 * cstore (Indomaret / Alfamart) payments and the platform handles the
 * second delivery as a no-op attempt-row write. See ADR-0010 (the
 * payments module) for the canonical idempotency contract.
 */
import {
  definePlugin,
  type Plugin,
} from "@mt-commerce/core/plugin";
import {
  MidtransPaymentProvider,
  MIDTRANS_PROVIDER_CODE,
} from "./provider.js";
import type { MidtransMode } from "./snap.js";

export interface MidtransOptions {
  /**
   * Server-side key from the Midtrans dashboard. REQUIRED.
   * Sandbox keys start with `SB-Mid-server-...`; production keys with
   * `Mid-server-...`. Treat both as secrets — never commit to source.
   */
  readonly serverKey: string;

  /**
   * Snap.js client key for the storefront's redirect/embed page. REQUIRED.
   * Public-by-design (it is loaded into the buyer's browser); validated
   * here only so a misconfiguration surfaces at boot.
   */
  readonly clientKey: string;

  /**
   * `"sandbox"` (default) or `"production"`. Switches both the Snap
   * endpoint and the Core API endpoint used for refunds.
   */
  readonly mode?: MidtransMode;

  /**
   * Callback URL Snap redirects buyers to when payment finishes
   * successfully. Typically the storefront's order-confirmed page.
   */
  readonly finishUrl?: string;

  /** Callback URL Snap redirects to on payment error. */
  readonly errorUrl?: string;

  /** Callback URL Snap redirects to on pending payment (VA, cstore). */
  readonly pendingUrl?: string;
}

/**
 * Plugin factory. Operators import the default export and call it inside
 * `mt-commerce.config.ts` (see the module-level docblock above for an
 * example). Also exported as a named binding for callers that prefer
 * `import { midtransPlugin } from "..."`.
 *
 * The factory pattern keeps operator options outside the manifest's
 * static shape, so we can validate options eagerly here rather than
 * dragging Zod into the loader.
 */
export function midtransPlugin(options: MidtransOptions): Plugin {
  return definePlugin({
    name: "@mt-commerce/plugin-payment-midtrans",
    version: "0.1.0",
    setup(ctx) {
      // Validation happens inside the constructor — surface boot-time
      // misconfiguration with a clear message that names the missing
      // option. The plugin loader catches and logs per-plugin failures.
      const provider = new MidtransPaymentProvider(options, ctx.log);
      ctx.registerPaymentProvider(provider);
      ctx.log.info(
        {
          mode: options.mode ?? "sandbox",
          providerCode: MIDTRANS_PROVIDER_CODE,
        },
        "[plugin-payment-midtrans] registered Midtrans payment provider",
      );
    },
  });
}

export default midtransPlugin;

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------
//
// The internals are exposed for advanced operators (custom dispatchers,
// admin tooling that needs to format Midtrans webhooks, integration tests).
// Default users only need the factory above.
//
export {
  MidtransPaymentProvider,
  MIDTRANS_PROVIDER_CODE,
} from "./provider.js";
export {
  buildSnapTransactionRequest,
  mapMidtransStatus,
  DEFAULT_SNAP_ENABLED_PAYMENTS,
  type MidtransTransactionStatus,
  type MidtransMappedOutcome,
} from "./templates.js";
export {
  computeMidtransSignature,
  verifyMidtransSignature,
} from "./signature.js";
export {
  SnapClient,
  MidtransApiError,
  SNAP_BASE_URLS,
  CORE_BASE_URLS,
  type MidtransMode,
  type SnapTransactionResponse,
  type MidtransRefundResponse,
} from "./snap.js";

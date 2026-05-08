/**
 * `@mt-commerce/plugin-shipping-biteship` — Biteship shipping integration.
 *
 * What it does:
 *   1. Registers a Biteship-backed `ShippingProvider` with the platform.
 *      The provider quotes through `/v1/rates/couriers` and creates
 *      orders through `/v1/orders`.
 *   2. Exposes a webhook verification + event mapper (`verifyWebhook`,
 *      `parseWebhook`) the api's webhook route layer drives. Biteship
 *      tracking events map to `fulfillment.shipped` / `fulfillment.delivered`.
 *   3. Ships a default seed list of the common Indonesian courier
 *      services (`JNE_REG`, `JNT_EZ`, ...) for the operator-run shipping
 *      methods seeding script. The plugin does NOT auto-mutate the
 *      `shipping_methods` table at boot — that decision belongs to the
 *      operator.
 *
 * Operator wiring (in `mt-commerce.config.ts`):
 *
 *   import { defineConfig } from "@mt-commerce/core/plugin";
 *   import biteshipPlugin from "@mt-commerce/plugin-shipping-biteship";
 *
 *   export default defineConfig({
 *     plugins: [
 *       biteshipPlugin({
 *         apiKey: process.env.BITESHIP_API_KEY!,
 *         mode: "production",
 *         origin: { postalCode: "12345" },
 *         couriers: ["jne", "jnt", "sicepat", "anteraja", "gojek", "grab"],
 *         webhookSecret: process.env.BITESHIP_WEBHOOK_SECRET,
 *       }),
 *     ],
 *   });
 *
 * See `./README.md` for the full setup guide, including the courier-method
 * seeding script and the webhook URL operators register in the Biteship
 * dashboard.
 */
import {
  definePlugin,
  type Plugin,
  type ShippingProvider as CoreShippingProvider,
} from "@mt-commerce/core/plugin";
import {
  BiteshipShippingProvider,
  type BiteshipShippingProviderOptions,
} from "./provider.js";

export {
  BiteshipShippingProvider,
  type BiteshipQuoteContextSource,
  type BiteshipShippingProviderOptions,
} from "./provider.js";
export {
  defaultBiteshipMethodSeeds,
  buildMethodIndex,
  type BiteshipMethodSeed,
} from "./methods.js";
export {
  BITESHIP_SIGNATURE_HEADER,
  mapBiteshipStatus,
  parseWebhook,
  verifyWebhook,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
} from "./webhook.js";
export { BiteshipClient, BiteshipError } from "./client.js";
export type {
  BiteshipCourierCode,
  BiteshipDestination,
  BiteshipItem,
  BiteshipOptions,
  BiteshipOrderResult,
  BiteshipOriginAddress,
  BiteshipQuoteOptions,
  BiteshipRate,
  BiteshipWebhookEvent,
  BiteshipWebhookEventKind,
} from "./types.js";

/**
 * Register-only re-export so an operator can introspect the provider
 * after the plugin loads (e.g. unit tests in the operator's repo).
 */
export type { CoreShippingProvider };

/**
 * Plugin factory. Returns a `Plugin` the api loader picks up via
 * `mt-commerce.config.ts`. Validates options eagerly so an operator
 * with a typo in their config sees the error at boot.
 */
export default function biteshipPlugin(
  options: BiteshipShippingProviderOptions,
): Plugin {
  if (!options || typeof options !== "object") {
    throw new Error(
      "@mt-commerce/plugin-shipping-biteship: options object is required.",
    );
  }
  if (!options.apiKey) {
    throw new Error(
      "@mt-commerce/plugin-shipping-biteship: options.apiKey is required.",
    );
  }
  if (!options.origin?.postalCode) {
    throw new Error(
      "@mt-commerce/plugin-shipping-biteship: options.origin.postalCode is required.",
    );
  }

  return definePlugin({
    name: "@mt-commerce/plugin-shipping-biteship",
    version: "0.1.0",
    setup(ctx) {
      const provider = new BiteshipShippingProvider(options, ctx.log);
      ctx.registerShippingProvider(provider);
      ctx.log.info(
        {
          mode: options.mode ?? "sandbox",
          couriers: options.couriers ?? null,
          originPostalCode: options.origin.postalCode,
        },
        "[plugin-shipping-biteship] setup complete",
      );
    },
  });
}

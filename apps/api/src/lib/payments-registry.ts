/**
 * Plugin-facing payment-provider registry.
 *
 * This file is a holding pen for the payment-provider extension point so
 * the plugin loader has somewhere to call into BEFORE the full payments
 * module ships (tracked in the v0.1 checklist's Payments stream and being
 * built in parallel). When the payments module lands it will:
 *
 *   1. Take ownership of this registry — the module's service consults
 *      `getPaymentProvider(code)` from here on `initiate / capture /
 *      refund / verifyWebhookSignature` so the registration surface
 *      stays stable for plugins that load before the module is wired.
 *
 *   2. Or move the registry into `apps/api/src/modules/payments/registry.ts`
 *      and re-export from here for backward compatibility — the choice is
 *      up to the payments module's author.
 *
 * Either way, the contract this file exposes — `register`, `get`,
 * `list` — is the contract the plugin loader binds against in
 * `PluginContext.registerPaymentProvider`. Keeping it here lets us ship
 * the loader and example plugin without blocking on the payments module.
 *
 * Why a singleton: payment providers are process-global. The loader
 * registers them at boot, request handlers and webhook handlers read
 * from them on every call. A factory-per-test pattern would force tests
 * to thread the registry through the entire DI graph for a value that
 * never changes after boot; the singleton with a `__resetForTesting`
 * escape hatch is the simpler trade.
 */
import type { PaymentProvider } from "@mt-commerce/core/plugin";
import { ConflictError, NotFoundError } from "./errors.js";

const providers = new Map<string, PaymentProvider>();

export function registerPaymentProvider(provider: PaymentProvider): void {
  if (providers.has(provider.code)) {
    throw new ConflictError(
      "Payment provider with this code is already registered.",
      { code: provider.code },
    );
  }
  providers.set(provider.code, provider);
}

/**
 * Look up a registered provider by code. Throws `NotFoundError` if no
 * provider is registered — callers (the future payments module's service)
 * should treat this as a 5xx-class boot/configuration error rather than a
 * 4xx because the operator's data references a provider that the running
 * process does not have loaded.
 */
export function getPaymentProvider(code: string): PaymentProvider {
  const provider = providers.get(code);
  if (!provider) {
    throw new NotFoundError("Payment provider not found.", { code });
  }
  return provider;
}

/** Best-effort lookup. Returns `undefined` rather than throwing. */
export function findPaymentProvider(code: string): PaymentProvider | undefined {
  return providers.get(code);
}

/** Snapshot of registered providers, in registration order. */
export function listPaymentProviders(): readonly PaymentProvider[] {
  return [...providers.values()];
}

/**
 * Test-only — drops every registration. The plugin loader's tests reset
 * between cases so a provider registered by one test does not leak into
 * the next.
 */
export function __resetPaymentProvidersForTesting(): void {
  providers.clear();
}

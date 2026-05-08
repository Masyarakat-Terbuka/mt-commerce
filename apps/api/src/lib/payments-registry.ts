/**
 * Plugin-facing payment-provider registry — thin bridge into the canonical
 * registry inside the payments module.
 *
 * History (now resolved): this file used to hold its own `Map<code,
 * PaymentProvider>` because the plugin loader landed before the payments
 * module did. The two registries lived in parallel: the loader wrote to
 * THIS map, but `payments/service.ts` read from
 * `modules/payments/providers/registry.ts` — so a plugin's
 * `ctx.registerPaymentProvider(...)` call never made its way to the
 * service that handles `/initiate`.
 *
 * Decision (Bridge 1, option B per the bridge plan): the modules
 * registry is the canonical one — it pre-registers the in-memory test
 * provider and is what the service consumes. This file becomes a thin
 * delegate that:
 *
 *   1. Adapts the plugin's `core.PaymentProvider` shape into the modules'
 *      `PaymentProvider` shape via `adaptCorePaymentProvider`. The two
 *      contracts are intentionally different (plugins compile against
 *      core; the service wants the discriminated `InitiateResult` and
 *      the canonical `VerifiedWebhook`).
 *
 *   2. Forwards register / get / list to the modules' singleton.
 *
 * Per ADR-0005 (modular monolith), this keeps the bounded context with
 * the module that owns it; the lib seam exists only because the plugin
 * loader cannot import from a module without leaking module internals
 * into the loader's API.
 *
 * Why a singleton: payment providers are process-global. The loader
 * registers them at boot, request handlers and webhook handlers read
 * from them on every call. A factory-per-test pattern would force
 * tests to thread the registry through the entire DI graph for a value
 * that never changes after boot; the singleton with a
 * `__resetForTesting` escape hatch is the simpler trade.
 */
import type { PaymentProvider as CorePaymentProvider } from "@mt-commerce/core/plugin";
import { adaptCorePaymentProvider } from "../modules/payments/providers/plugin-adapter.js";
import {
  paymentProviderRegistry,
  type PaymentProviderRegistry,
} from "../modules/payments/providers/registry.js";
import type { PaymentProvider as ModulePaymentProvider } from "../modules/payments/providers/types.js";
import { ConflictError, NotFoundError } from "./errors.js";

/**
 * Track which adapter we minted for a given plugin code so `list()` can
 * surface the original core provider's metadata (displayName, etc.) and
 * tests can assert on the bridge without round-tripping through the
 * adapter shape.
 */
const adapted = new Map<
  string,
  { core: CorePaymentProvider; module: ModulePaymentProvider }
>();

/**
 * Register a plugin-supplied core `PaymentProvider`. The provider is
 * adapted into the modules' `PaymentProvider` shape and forwarded to the
 * canonical registry; downstream `paymentService.initiate(...)` calls
 * resolve through the same registry and reach this provider.
 *
 * Throws `ConflictError` when a provider with the same code is already
 * registered (in either the canonical registry or this bridge — the
 * canonical registry's pre-registered `in_memory_test` is reachable
 * through `getPaymentProvider("in_memory_test")` for that reason).
 */
export function registerPaymentProvider(provider: CorePaymentProvider): void {
  if (adapted.has(provider.code)) {
    throw new ConflictError(
      "Payment provider with this code is already registered.",
      { code: provider.code },
    );
  }
  const moduleProvider = adaptCorePaymentProvider(provider);
  try {
    paymentProviderRegistry.register(moduleProvider);
  } catch (err) {
    // Re-throw the modules registry's plain Error as a typed ConflictError
    // so the loader's per-plugin catch surfaces a uniform error shape.
    const message = err instanceof Error ? err.message : String(err);
    throw new ConflictError(
      "Payment provider with this code is already registered.",
      { code: provider.code, reason: message },
    );
  }
  adapted.set(provider.code, { core: provider, module: moduleProvider });
}

/**
 * Look up a registered provider by code. Returns the ADAPTED (modules-
 * shaped) provider — callers from the api side use this surface; callers
 * from the plugin side hold their own reference to the core provider.
 *
 * Throws `NotFoundError` when no provider is registered. Returns the
 * canonical registry's pre-registered providers (e.g. `in_memory_test`)
 * even when they were not registered through this bridge — the registry
 * is one logical thing.
 */
export function getPaymentProvider(code: string): ModulePaymentProvider {
  try {
    return paymentProviderRegistry.resolve(code);
  } catch {
    throw new NotFoundError("Payment provider not found.", { code });
  }
}

/** Best-effort lookup. Returns `undefined` rather than throwing. */
export function findPaymentProvider(
  code: string,
): ModulePaymentProvider | undefined {
  try {
    return paymentProviderRegistry.resolve(code);
  } catch {
    return undefined;
  }
}

/**
 * Snapshot of registered providers, in registration order. Returns the
 * MODULES-shaped providers from the canonical registry (matches what
 * the service consumes), which includes the pre-registered in-memory
 * test provider plus every plugin-registered provider via the adapter.
 */
export function listPaymentProviders(): readonly ModulePaymentProvider[] {
  return paymentProviderRegistry.list();
}

/**
 * Test-only — drops every plugin registration AND the modules registry's
 * own state. The plugin loader's tests reset between cases so a provider
 * registered by one test does not leak into the next.
 *
 * After reset, the canonical registry is empty (the in-memory test
 * provider is NOT re-registered automatically — tests that need it
 * register their own instance, see `apps/api/tests/modules/payments/`).
 */
export function __resetPaymentProvidersForTesting(): void {
  adapted.clear();
  paymentProviderRegistry.reset();
}

/**
 * Test-only — peek at the dual map so tests can assert "the plugin's
 * own core provider object is what the canonical registry now serves
 * (via the adapter)". Production callers do NOT use this.
 */
export function __getAdaptedPluginProviderForTesting(
  code: string,
): { core: CorePaymentProvider; module: ModulePaymentProvider } | undefined {
  return adapted.get(code);
}

/**
 * Re-export of the canonical registry shape so callers that need to
 * construct an alternative registry for tests have a single import path.
 */
export type { PaymentProviderRegistry };

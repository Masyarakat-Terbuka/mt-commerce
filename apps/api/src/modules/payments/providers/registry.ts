/**
 * Provider registry — `Map<code, PaymentProvider>` keyed by the
 * provider's stable `code`.
 *
 * Why a registry (rather than constructor-injecting providers into the
 * service)?
 *
 *   - The plugin loader is a separate workstream. Plugins call
 *     `paymentProviderRegistry.register(provider)` at startup with no
 *     reach into this module's internals.
 *
 *   - The service resolves the provider at call time from the row's
 *     `provider` column. A row written months ago referencing a
 *     `code` whose plugin has since been uninstalled fails fast
 *     here with a clear error rather than crashing deep inside a
 *     null-deref.
 *
 *   - Tests construct their own registry instance and inject it into
 *     `PaymentService`, so a spec exercising "what happens when the
 *     provider is missing" does not have to mutate the global.
 *
 * The default singleton (`paymentProviderRegistry`) is registered with
 * the `InMemoryTestPaymentProvider` so a developer running the API
 * locally without a plugin sees a usable surface for end-to-end
 * checkout tests.
 */
import type { PaymentProvider } from "./types.js";
import { createInMemoryTestPaymentProvider } from "./in-memory.js";

export interface PaymentProviderRegistry {
  /** Register a provider by its `code`. Re-registration with the same code throws. */
  register(provider: PaymentProvider): void;
  /** Resolve a provider, or throw `Error` with a clear message if unknown. */
  resolve(code: string): PaymentProvider;
  /** Read-only listing for diagnostic surfaces. */
  list(): ReadonlyArray<PaymentProvider>;
  /** Test seam — drop every registration. Production callers do NOT call this. */
  reset(): void;
}

export function createPaymentProviderRegistry(): PaymentProviderRegistry {
  const providers = new Map<string, PaymentProvider>();
  return {
    register(provider) {
      if (providers.has(provider.code)) {
        // Refusing re-registration prevents two plugins from silently
        // overriding each other's claim to a code. The operator sees
        // the conflict at startup, not as a mysterious wrong-provider
        // call mid-checkout.
        throw new Error(
          `payment provider already registered for code "${provider.code}"`,
        );
      }
      providers.set(provider.code, provider);
    },
    resolve(code) {
      const provider = providers.get(code);
      if (!provider) {
        throw new Error(`unknown payment provider code: "${code}"`);
      }
      return provider;
    },
    list() {
      return [...providers.values()];
    },
    reset() {
      providers.clear();
    },
  };
}

/**
 * Default singleton. Pre-registered with the in-memory test provider so
 * the API has at least one functional `code` out of the box. Real
 * providers (Midtrans, Xendit) are added by their plugin's loader.
 */
export const paymentProviderRegistry: PaymentProviderRegistry =
  createPaymentProviderRegistry();

paymentProviderRegistry.register(createInMemoryTestPaymentProvider());

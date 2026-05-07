/**
 * `ShippingProvider` interface — the contract every provider implements.
 *
 * v0.1 surface is intentionally narrow: a single `quote` method that
 * returns the price for a method+currency pair. The cart/checkout flow
 * never needs to know whether the price was a configured flat rate
 * (manual) or a dynamic API call (plugin), which keeps the integration
 * stable as plugin providers land.
 */
import type { Money } from "@mt-commerce/core/money";
import type { ShippingMethod, ShippingProviderKind } from "../types.js";

export interface ShippingProvider {
  /** Marker so the registry can map `provider_kind` → implementation. */
  readonly kind: ShippingProviderKind;
  /**
   * Produce a shipping quote for the given method. Implementations must
   * return a `Money` whose currency equals the requested currency, or
   * throw a domain error (`ValidationError {code:"currency_mismatch"}`)
   * when the method is incompatible with the requested currency.
   */
  quote(
    method: ShippingMethod,
    opts: { currency: string },
  ): Promise<Money>;
}

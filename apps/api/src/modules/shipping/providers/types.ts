/**
 * `ShippingProvider` interface — the contract every provider implements.
 *
 * v0.1 surface is intentionally narrow: a single `quote` method that
 * returns the price for a method+currency pair, with optional destination
 * and item context for plugin providers (Biteship, JNE direct) that need
 * a real shipment to price. The cart/checkout flow never needs to know
 * whether the price was a configured flat rate (manual) or a dynamic API
 * call (plugin), which keeps the integration stable as plugin providers
 * land.
 *
 * The `ctx` shape mirrors `ShippingQuoteContext` from
 * `@mt-commerce/core/plugin` so the api-internal manual provider and a
 * plugin provider share one signature.
 */
import type { Money } from "@mt-commerce/core/money";
import type { ShippingQuoteContext } from "@mt-commerce/core/plugin";
import type { ShippingMethod, ShippingProviderKind } from "../types.js";

export interface ShippingProvider {
  /** Marker so the registry can map `provider_kind` → implementation. */
  readonly kind: ShippingProviderKind;
  /**
   * Produce a shipping quote for the given method. Implementations must
   * return a `Money` whose currency equals `ctx.currency`, or throw a
   * domain error (`ValidationError {code:"currency_mismatch"}`) when
   * the method is incompatible with the requested currency.
   *
   * The `destination` and `items` fields are optional; manual providers
   * ignore them, plugin providers consume them to compute real rates.
   */
  quote(method: ShippingMethod, ctx: ShippingQuoteContext): Promise<Money>;
}

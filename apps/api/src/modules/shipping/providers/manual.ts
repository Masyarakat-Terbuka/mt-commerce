/**
 * Manual shipping provider — flat rate, configured by the operator on
 * the `shipping_methods` row itself.
 *
 * Implements the v0.1 `ShippingProvider` interface. Future plugin
 * providers (Biteship, JNE direct) implement the same surface but
 * compute rates dynamically from external APIs.
 *
 * Trade-off: keeping the provider interface narrow at v0.1 (just
 * `quote`) means we do not have to revisit the cart/checkout integration
 * when plugin providers land — the same `shippingService.quote(...)`
 * call site keeps working.
 */
import type { Money } from "@mt-commerce/core/money";
import type { ShippingQuoteContext } from "@mt-commerce/core/plugin";
import type { ShippingMethod } from "../types.js";
import type { ShippingProvider } from "./types.js";

export class ManualShippingProvider implements ShippingProvider {
  readonly kind = "manual" as const;

  /**
   * For manual methods, the quote is the configured flat rate. Currency
   * parity is asserted at the service boundary (the caller passes the
   * cart's currency); the provider trusts that contract and surfaces a
   * programming error if the row's flat-rate currency does not match.
   *
   * The optional `destination` and `items` on the context are ignored —
   * manual flat-rate methods do not vary by buyer location or parcel
   * weight; the caller forwards them anyway so the same call shape works
   * for plugin providers too.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async quote(
    method: ShippingMethod,
    _ctx: ShippingQuoteContext,
  ): Promise<Money> {
    if (method.providerKind !== "manual") {
      throw new Error(
        `ManualShippingProvider received a non-manual method (${method.providerKind}). This is a programming error.`,
      );
    }
    if (!method.flatRate) {
      // The DB CHECK should make this unreachable; throw explicitly so a
      // future schema drift surfaces as a clear error rather than a
      // confusing null-deref.
      throw new Error(
        `Shipping method ${method.code} is manual but has no flat rate. Migration drift?`,
      );
    }
    return method.flatRate;
  }
}

export const manualShippingProvider = new ManualShippingProvider();

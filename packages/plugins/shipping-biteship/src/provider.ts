/**
 * `BiteshipShippingProvider` — concrete implementation of the
 * `ShippingProvider` contract from `@mt-commerce/core/plugin`.
 *
 * Two-tier surface:
 *
 *   1. `quote(method, { currency })` — the contract signature the api's
 *      shipping service calls. It REQUIRES destination + item context to
 *      produce a real Biteship rate. Until the v0.1 service learns to
 *      pass that context (the cart already carries it; piping it into
 *      `ShippingProvider.quote` is a follow-up), calling this method
 *      without first installing a context source throws a clear error.
 *      Operators bridge this by calling {@link quoteRates} from a
 *      checkout extension that holds the cart context, or by passing a
 *      `defaultContextProvider` at construction time.
 *
 *   2. `quoteRates(method, opts)` — full-context quote that talks to
 *      `/v1/rates/couriers` directly. This is what the eventual
 *      cart-aware quote path calls; `tests/rates.test.ts` exercises it
 *      against a fake fetch.
 *
 * `createOrder(fulfillment, address, items)` — calls `/v1/orders` with
 * origin + destination + items + courier. Returns `{ trackingCode,
 * providerRef }`. Webhook verification + parsing live in `webhook.ts`.
 */
import type { Money } from "@mt-commerce/core/money";
import type {
  PluginLogger,
  ShippingMethodLike,
  ShippingProvider as CoreShippingProvider,
} from "@mt-commerce/core/plugin";
import { BiteshipClient } from "./client.js";
import {
  buildMethodIndex,
  defaultBiteshipMethodSeeds,
  type BiteshipMethodSeed,
} from "./methods.js";
import {
  DEFAULT_COURIERS,
  type BiteshipDestination,
  type BiteshipItem,
  type BiteshipOptions,
  type BiteshipOrderResult,
  type BiteshipQuoteOptions,
  type BiteshipRate,
} from "./types.js";

/**
 * Optional source the provider consults when called through the bare
 * `ShippingProvider.quote` signature. Returns the cart context for the
 * in-flight quote; returning `null` causes `quote` to throw rather than
 * fall back to a meaningless default.
 *
 * Most operators wire context from the storefront's checkout state.
 * v0.1 leaves the wiring to the operator; once mt-commerce extends
 * `ShippingProvider.quote` to carry items+destination, this seam is
 * removed.
 */
export type BiteshipQuoteContextSource = (
  method: ShippingMethodLike,
  opts: { currency: string },
) =>
  | (Omit<BiteshipQuoteOptions, "currency"> & { currency?: string })
  | null
  | Promise<
      (Omit<BiteshipQuoteOptions, "currency"> & { currency?: string }) | null
    >;

export interface BiteshipShippingProviderOptions extends BiteshipOptions {
  /**
   * Operator-supplied seed list used to map a `shipping_method.code`
   * back to the Biteship `(courier, service)` pair. Defaults to
   * {@link defaultBiteshipMethodSeeds}. Must contain a row per
   * `shipping_methods.code` the plugin will service — duplicate codes
   * throw at construction time so misconfiguration fails fast.
   */
  readonly methodSeeds?: readonly BiteshipMethodSeed[];
  /** See {@link BiteshipQuoteContextSource}. */
  readonly defaultContextProvider?: BiteshipQuoteContextSource;
  /**
   * Display name used for `ShippingProvider.displayName`. Defaults to
   * `"Biteship"`; multi-region operators may override.
   */
  readonly displayName?: string;
}

const PROVIDER_CODE = "biteship" as const;
const SUPPORTED_CURRENCY = "IDR" as const;

interface BiteshipRatesResponse {
  readonly success?: boolean;
  readonly object?: string;
  readonly pricing?: ReadonlyArray<{
    readonly courier_code?: string;
    readonly courier_name?: string;
    readonly courier_service_code?: string;
    readonly courier_service_name?: string;
    readonly price?: number;
    readonly duration?: string;
    readonly available_for_cash_on_delivery?: boolean;
    readonly service_type?: string;
  }>;
}

interface BiteshipOrderResponse {
  readonly success?: boolean;
  readonly id?: string;
  readonly courier?: {
    readonly tracking_id?: string | null;
    readonly waybill_id?: string | null;
  };
}

export class BiteshipShippingProvider implements CoreShippingProvider {
  readonly code = PROVIDER_CODE;
  readonly displayName: string;

  private readonly client: BiteshipClient;
  private readonly methodIndex: Map<string, BiteshipMethodSeed>;
  private readonly defaultCouriers: readonly string[];
  private readonly origin: BiteshipOptions["origin"];
  private readonly contextProvider?: BiteshipQuoteContextSource;
  private readonly log?: PluginLogger;

  constructor(opts: BiteshipShippingProviderOptions, log?: PluginLogger) {
    this.client = new BiteshipClient({
      apiKey: opts.apiKey,
      mode: opts.mode,
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
    });
    this.methodIndex = buildMethodIndex(
      opts.methodSeeds ?? defaultBiteshipMethodSeeds,
    );
    this.defaultCouriers =
      opts.couriers && opts.couriers.length > 0
        ? Array.from(opts.couriers)
        : Array.from(DEFAULT_COURIERS);
    this.origin = opts.origin;
    this.contextProvider = opts.defaultContextProvider;
    this.displayName = opts.displayName ?? "Biteship";
    this.log = log;
  }

  // -------------------------------------------------------------------
  // Core ShippingProvider contract
  // -------------------------------------------------------------------

  /**
   * The narrow `ShippingProvider.quote` the platform calls. v0.1's
   * shipping service does not yet pass cart items / destination through
   * this signature, so we look up the operator-supplied context source
   * (or throw a clear error if none was wired). This keeps the plugin
   * honest — we never invent a price.
   */
  async quote(
    method: ShippingMethodLike,
    opts: { currency: string },
  ): Promise<Money> {
    if (opts.currency !== SUPPORTED_CURRENCY) {
      throw new Error(
        `Biteship only quotes in ${SUPPORTED_CURRENCY}; got ${opts.currency}.`,
      );
    }
    if (!this.contextProvider) {
      throw new Error(
        `BiteshipShippingProvider.quote requires a destination + item context. ` +
          `Pass \`defaultContextProvider\` to the plugin factory, or call ` +
          `\`quoteRates(method, opts)\` directly from a route that holds the cart.`,
      );
    }
    const ctx = await this.contextProvider(method, opts);
    if (!ctx) {
      throw new Error(
        `BiteshipShippingProvider.quote: context provider returned null for method ${method.code}.`,
      );
    }
    const rate = await this.quoteRates(method, {
      ...ctx,
      currency: ctx.currency ?? opts.currency,
    });
    return rate.money;
  }

  // -------------------------------------------------------------------
  // Plugin-specific surface (richer than the core contract)
  // -------------------------------------------------------------------

  /**
   * Full-context quote. Calls Biteship's `/v1/rates/couriers` with the
   * configured origin + caller's destination + items + the courier list
   * (either the method's mapped courier or the plugin-default ladder).
   *
   * Returns the matching rate plus the full ladder. Selection rule:
   *   - If `method.code` resolves to a `(courier, service)` seed, the
   *     rate matching that exact pair is returned.
   *   - Otherwise the cheapest rate across all returned couriers wins.
   *
   * Currency is fixed to IDR — Biteship operates only inside Indonesia
   * for v0.1.
   */
  async quoteRates(
    method: ShippingMethodLike,
    opts: BiteshipQuoteOptions,
  ): Promise<{ money: Money; rate: BiteshipRate; rates: BiteshipRate[] }> {
    if (opts.currency !== SUPPORTED_CURRENCY) {
      throw new Error(
        `Biteship only quotes in ${SUPPORTED_CURRENCY}; got ${opts.currency}.`,
      );
    }
    if (!opts.destination?.postalCode) {
      throw new Error(
        "Biteship quote requires a destination postal code.",
      );
    }
    if (!opts.items || opts.items.length === 0) {
      throw new Error("Biteship quote requires at least one item.");
    }

    const seed = this.methodIndex.get(method.code);
    const couriers =
      seed
        ? [seed.courierCode]
        : this.defaultCouriers.length > 0
          ? this.defaultCouriers
          : Array.from(DEFAULT_COURIERS);

    const body: Record<string, unknown> = {
      origin_postal_code: this.origin.postalCode,
      destination_postal_code: opts.destination.postalCode,
      couriers: couriers.join(","),
      items: opts.items.map(serializeItem),
    };
    if (this.origin.latitude !== undefined && this.origin.longitude !== undefined) {
      body.origin_latitude = this.origin.latitude;
      body.origin_longitude = this.origin.longitude;
    }
    if (
      opts.destination.latitude !== undefined &&
      opts.destination.longitude !== undefined
    ) {
      body.destination_latitude = opts.destination.latitude;
      body.destination_longitude = opts.destination.longitude;
    }

    const response = await this.client.request<BiteshipRatesResponse>({
      path: "/v1/rates/couriers",
      method: "POST",
      body,
    });

    let rates = (response.pricing ?? [])
      .map(toRate)
      .filter((r): r is BiteshipRate => r !== null);

    if (opts.cod === true) {
      rates = rates.filter((r) => r.cod);
    }
    if (rates.length === 0) {
      throw new Error(
        `Biteship returned no ${opts.cod ? "COD-capable " : ""}rates for method ${method.code}.`,
      );
    }

    let chosen: BiteshipRate;
    if (seed) {
      const matched = rates.find(
        (r) =>
          r.courierCode.toLowerCase() === seed.courierCode.toLowerCase() &&
          r.courierServiceCode.toLowerCase() === seed.courierService.toLowerCase(),
      );
      if (!matched) {
        throw new Error(
          `Biteship did not return a rate for ${seed.courierCode}/${seed.courierService} (method ${method.code}).`,
        );
      }
      chosen = matched;
    } else {
      chosen = rates.reduce((min, r) => (r.price < min.price ? r : min));
    }

    this.log?.debug(
      { methodCode: method.code, courier: chosen.courierCode, price: chosen.price },
      "[plugin-shipping-biteship] quote",
    );

    return {
      money: { amount: BigInt(chosen.price), currency: SUPPORTED_CURRENCY },
      rate: chosen,
      rates,
    };
  }

  /**
   * Create a Biteship order against the chosen courier service. The
   * returned `trackingCode` may be null when the courier issues codes
   * asynchronously — the platform surfaces that as a fulfillment with a
   * pending tracking code, and the webhook handler back-fills.
   */
  async createOrder(input: {
    /** Stable mt-commerce fulfillment id, used as Biteship's reference. */
    readonly fulfillmentId: string;
    /** Shipping method code the order is for; resolves to a courier+service. */
    readonly methodCode: string;
    readonly destination: BiteshipDestination;
    readonly items: readonly BiteshipItem[];
    readonly cod?: boolean;
    readonly codAmount?: number;
    /** Free-form note forwarded to the courier (delivery instructions). */
    readonly deliveryNote?: string;
  }): Promise<BiteshipOrderResult> {
    const seed = this.methodIndex.get(input.methodCode);
    if (!seed) {
      throw new Error(
        `BiteshipShippingProvider.createOrder: unknown method code ${input.methodCode}. ` +
          `Add a seed entry or pass \`methodSeeds\` to the plugin.`,
      );
    }
    if (!input.destination.contactName || !input.destination.contactPhone) {
      throw new Error(
        "Biteship createOrder requires destination contactName and contactPhone.",
      );
    }
    if (input.cod && (input.codAmount === undefined || input.codAmount <= 0)) {
      throw new Error(
        "Biteship COD orders require a positive `codAmount` (whole rupiah).",
      );
    }

    const body: Record<string, unknown> = {
      reference_id: input.fulfillmentId,
      shipper_contact_name: this.origin.contactName ?? "",
      shipper_contact_phone: this.origin.contactPhone ?? "",
      origin_contact_name: this.origin.contactName ?? "",
      origin_contact_phone: this.origin.contactPhone ?? "",
      origin_address: this.origin.address ?? "",
      origin_postal_code: this.origin.postalCode,
      destination_contact_name: input.destination.contactName,
      destination_contact_phone: input.destination.contactPhone,
      destination_address: input.destination.address ?? "",
      destination_postal_code: input.destination.postalCode,
      courier_company: seed.courierCode,
      courier_type: seed.courierService,
      delivery_type: "now",
      items: input.items.map(serializeItem),
    };
    if (input.destination.contactEmail) {
      body.destination_contact_email = input.destination.contactEmail;
    }
    if (this.origin.latitude !== undefined && this.origin.longitude !== undefined) {
      body.origin_latitude = this.origin.latitude;
      body.origin_longitude = this.origin.longitude;
    }
    if (
      input.destination.latitude !== undefined &&
      input.destination.longitude !== undefined
    ) {
      body.destination_latitude = input.destination.latitude;
      body.destination_longitude = input.destination.longitude;
    }
    if (input.deliveryNote) {
      body.delivery_note = input.deliveryNote;
    }
    if (input.cod) {
      body.courier_insurance = 0;
      body.cod = {
        // Biteship uses the order_value field for COD collection. The
        // amount is whole rupiah.
        amount: input.codAmount,
      };
    }

    const response = await this.client.request<BiteshipOrderResponse>({
      path: "/v1/orders",
      method: "POST",
      body,
    });

    if (!response.id) {
      throw new Error("Biteship order response missing `id`.");
    }
    const trackingCode =
      response.courier?.tracking_id ?? response.courier?.waybill_id ?? null;

    this.log?.info(
      {
        fulfillmentId: input.fulfillmentId,
        methodCode: input.methodCode,
        biteshipOrderId: response.id,
        trackingCode,
      },
      "[plugin-shipping-biteship] order created",
    );

    return {
      trackingCode,
      providerRef: response.id,
      raw: response as unknown as Record<string, unknown>,
    };
  }
}

function toRate(
  row: NonNullable<BiteshipRatesResponse["pricing"]>[number],
): BiteshipRate | null {
  if (
    typeof row.courier_code !== "string" ||
    typeof row.courier_service_code !== "string" ||
    typeof row.price !== "number"
  ) {
    return null;
  }
  return {
    courierCode: row.courier_code,
    courierName: row.courier_name ?? row.courier_code,
    courierServiceCode: row.courier_service_code,
    courierServiceName: row.courier_service_name ?? row.courier_service_code,
    price: row.price,
    duration: row.duration ?? "",
    cod: row.available_for_cash_on_delivery === true,
    serviceType: row.service_type ?? "standard",
  };
}

function serializeItem(item: BiteshipItem): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: item.name,
    quantity: item.quantity,
    value: item.value,
    weight: item.weight,
  };
  if (item.id) out.sku = item.id;
  if (item.length !== undefined) out.length = item.length;
  if (item.width !== undefined) out.width = item.width;
  if (item.height !== undefined) out.height = item.height;
  return out;
}

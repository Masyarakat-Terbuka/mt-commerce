/**
 * Public option and shape types for `@mt-commerce/plugin-shipping-biteship`.
 *
 * Exported separately from `index.ts` so callers can import the option
 * shapes (for typed config wiring) without pulling the whole plugin
 * factory into their type graph.
 */

/**
 * Couriers Biteship exposes that mt-commerce ships with first-class
 * defaults for. Operators can opt into others by passing the lowercase
 * Biteship courier code in `BiteshipOptions.couriers`.
 */
export type BiteshipCourierCode =
  | "jne"
  | "jnt"
  | "sicepat"
  | "anteraja"
  | "gojek"
  | "grab"
  | "ninja"
  | "pos"
  | "sap"
  | "lion"
  | "rpx"
  | "tiki";

/**
 * Default courier set seeded into a quote request when the operator does
 * not pass `couriers` explicitly. Covers the major nationwide and same-day
 * options Indonesian merchants typically enable first.
 */
export const DEFAULT_COURIERS: readonly BiteshipCourierCode[] = Object.freeze([
  "jne",
  "jnt",
  "sicepat",
  "anteraja",
  "gojek",
  "grab",
]);

export interface BiteshipOriginAddress {
  /** Indonesian postal code, 5 digits. */
  readonly postalCode: string;
  /** Optional latitude for instant/same-day couriers (gojek/grab). */
  readonly latitude?: number;
  /** Optional longitude for instant/same-day couriers (gojek/grab). */
  readonly longitude?: number;
  /**
   * Optional street address. Required by `/v1/orders` for some couriers;
   * the plugin forwards it when present.
   */
  readonly address?: string;
  /** Optional contact name on the origin (sender). */
  readonly contactName?: string;
  /** Optional contact phone on the origin (sender). */
  readonly contactPhone?: string;
}

export interface BiteshipOptions {
  /**
   * Biteship API key from the dashboard. Required.
   * https://biteship.com/id/dashboard/account/api
   */
  readonly apiKey: string;
  /**
   * `"sandbox"` (default) routes to the sandbox host. `"production"`
   * routes to the live host. Both share the same `/v1` path layout.
   */
  readonly mode?: "sandbox" | "production";
  /** Origin postal code (and optional address) for rate calculation. */
  readonly origin: BiteshipOriginAddress;
  /**
   * Couriers to enable. Defaults to {@link DEFAULT_COURIERS}.
   * Pass an empty array to query every courier on the account.
   */
  readonly couriers?: readonly string[];
  /**
   * Optional override for the API base URL. Useful in tests and for
   * operators routing through a corporate proxy. When unset, defaults to
   * the Biteship public host for the chosen mode.
   */
  readonly baseUrl?: string;
  /**
   * Webhook secret used to verify the `x-biteship-signature` HMAC-SHA256
   * header on incoming tracking callbacks. Required for the webhook
   * handler; the plugin's quote/order paths work without it.
   */
  readonly webhookSecret?: string;
  /**
   * Custom fetch impl, primarily for tests. Defaults to the global
   * `fetch`. Plugins do not take an SDK dependency — the upstream API
   * is small enough to drive directly.
   */
  readonly fetch?: typeof fetch;
}

/**
 * Item shape mt-commerce hands to the plugin for rate quoting and order
 * creation. Fields mirror what Biteship's `/v1/rates/couriers` and
 * `/v1/orders` accept — values are unitless from the platform's view
 * (mt-commerce does not yet model item dimensions in core).
 */
export interface BiteshipItem {
  /** Stable identifier, surfaced to the courier as the SKU/reference. */
  readonly id?: string;
  /** Display name. */
  readonly name: string;
  /** Number of this item in the parcel. */
  readonly quantity: number;
  /** Per-item value in the smallest unit of IDR (whole rupiah). */
  readonly value: number;
  /** Per-item weight in grams. */
  readonly weight: number;
  /** Optional dimensions in cm. Forwarded when present. */
  readonly length?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Destination passed to `quote` and `createOrder`. Only the postal code
 * is required for rate quoting; full address fields are required for
 * order creation.
 */
export interface BiteshipDestination {
  readonly postalCode: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly address?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly contactEmail?: string;
}

/**
 * Single rate row returned by Biteship for one courier+service pair.
 * Surfaced through the provider so callers higher up the stack (admin
 * rate browser, checkout flow) can render the full ladder.
 */
export interface BiteshipRate {
  readonly courierCode: string;
  readonly courierName: string;
  readonly courierServiceCode: string;
  readonly courierServiceName: string;
  /** Quoted price, whole rupiah. */
  readonly price: number;
  /** Estimated delivery duration text from Biteship (e.g. "1-2 hari"). */
  readonly duration: string;
  /** True when the courier+service combination supports COD. */
  readonly cod: boolean;
  /** Service type (`"standard"`, `"express"`, `"instant"`, ...). */
  readonly serviceType: string;
}

/**
 * Quote-time options the platform passes through. `cod: true` filters
 * the returned rates to COD-capable courier services; v0.1 surfaces the
 * flag on `createOrder` too so the order is filed as COD upstream.
 */
export interface BiteshipQuoteOptions {
  /** Currency the caller expects the response in. Always `"IDR"` in v0.1. */
  readonly currency: string;
  /** Items in the parcel — drives weight/value/dimension fields. */
  readonly items: readonly BiteshipItem[];
  /** Destination postal code (and optional coordinates). */
  readonly destination: BiteshipDestination;
  /**
   * When `true`, only COD-capable couriers are returned. The plugin
   * filters at the response boundary; Biteship returns the same ladder
   * either way.
   */
  readonly cod?: boolean;
}

/**
 * Outcome of a successful `/v1/orders` call. The platform's shipping
 * service stores `trackingCode` on the fulfillment row; `providerRef`
 * is the Biteship order id, kept so the webhook handler can correlate.
 */
export interface BiteshipOrderResult {
  /** Courier-issued tracking number. May be null until the courier picks up. */
  readonly trackingCode: string | null;
  /** Biteship's internal order id (`order_id`). */
  readonly providerRef: string;
  /** Optional snapshot of the raw response, for audit. */
  readonly raw?: Record<string, unknown>;
}

/**
 * Mapped webhook event the plugin returns from `parseWebhook`. The api
 * route layer drives the corresponding shipping-service transition
 * (`markShipped` / `markDelivered`) — the plugin itself never reaches
 * into the database.
 */
export type BiteshipWebhookEventKind =
  | "fulfillment.shipped"
  | "fulfillment.delivered"
  | "ignored";

export interface BiteshipWebhookEvent {
  readonly kind: BiteshipWebhookEventKind;
  /** Biteship `order_id` from the payload — correlates back to `providerRef`. */
  readonly providerRef: string;
  /** Tracking code present on the payload, if any. */
  readonly trackingCode: string | null;
  /** Original Biteship event status string (e.g. `"picked_up"`, `"delivered"`). */
  readonly biteshipStatus: string;
  /** Timestamp from the payload, parsed to a Date when present. */
  readonly occurredAt: Date | null;
  /** The parsed body, unmodified. */
  readonly raw: Record<string, unknown>;
}

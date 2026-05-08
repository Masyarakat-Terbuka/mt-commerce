/**
 * Plugin contract for `@mt-commerce/core` — `definePlugin`, `defineConfig`,
 * extension-point interfaces, and the `PluginContext` handed to a plugin's
 * `setup(ctx)`.
 *
 * Why this lives in `@mt-commerce/core`:
 *
 *   - Plugins must not depend on `@mt-commerce/api`. The api package pulls
 *     in Hono, Drizzle, Better Auth, postgres-js, and the database schema —
 *     none of which a plugin author should be forced to install (or even
 *     have available at type-check time).
 *
 *   - `@mt-commerce/core` is already the lone shared dependency for plugin
 *     packages (see ADR-0008's implementation note: "Plugin packages declare
 *     their compatible mt-commerce range through `peerDependencies` against
 *     `@mt-commerce/core`"). Putting the plugin contract here keeps the
 *     dependency graph one-way: plugin → core ← api.
 *
 * What this file does NOT contain:
 *
 *   - Anything that touches the Hono app, the database, or any other api
 *     concern. The api package owns the loader (`apps/api/src/lib/plugins.ts`)
 *     and the registry adapters that wire `PluginContext.registerXxx` into
 *     the runtime services.
 */
import type { Money } from "./money.js";

// ---------------------------------------------------------------------------
// Logger — minimal pino-shaped surface so plugins can log without taking
// on a peer-dep on pino itself.
// ---------------------------------------------------------------------------

/**
 * Minimal log surface. Plugins receive a child logger scoped to their name
 * (`{ plugin: "<name>" }`). The api builds this from its own pino instance;
 * a plugin author can rely on the `info | warn | error | debug` quartet
 * being present.
 *
 * Each method accepts EITHER a message string OR a structured object plus a
 * message string, mirroring pino's two-arg form. Plugins should prefer the
 * structured form so the log pipeline can index on the fields.
 */
export interface PluginLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Payment provider — generic plugin contract.
// ---------------------------------------------------------------------------

/**
 * Normalized intent shape the platform hands a payment provider. The api
 * payments module owns the canonical `PaymentIntent`; this is the structural
 * subset every provider sees so the contract here does not pull in the
 * api's database row types.
 */
export interface PaymentIntentLike {
  /** Provider-agnostic intent id assigned by the platform. */
  readonly id: string;
  /** Order id the intent settles. */
  readonly orderId: string;
  /** The amount to charge, currency-typed via `Money`. */
  readonly amount: Money;
  /** Idempotency key; providers MUST forward this to the upstream API. */
  readonly idempotencyKey: string;
  /** Free-form metadata the operator attached at intent creation. */
  readonly metadata?: Record<string, string>;
}

/**
 * Outcome the provider returns from `initiate`. `redirect_url` is set when
 * the provider needs the buyer to bounce through a hosted page (Snap, 3DS).
 * `next_action` carries provider-specific instructions (QR code payload,
 * VA number) the storefront renders to complete the flow.
 */
export interface PaymentInitiateResult {
  /** Provider's id for the transaction; stored alongside the intent. */
  readonly providerTransactionId: string;
  /** Redirect for hosted-page flows. */
  readonly redirectUrl?: string;
  /** Free-form next-step payload (QR string, VA number, etc.). */
  readonly nextAction?: Record<string, unknown>;
  /** Optional snapshot of the raw provider response, for audit. */
  readonly raw?: Record<string, unknown>;
}

export interface PaymentCaptureResult {
  readonly providerTransactionId: string;
  readonly amountCaptured: Money;
  readonly raw?: Record<string, unknown>;
}

export interface PaymentRefundResult {
  readonly providerTransactionId: string;
  readonly amountRefunded: Money;
  readonly raw?: Record<string, unknown>;
}

/**
 * Payment provider plugin interface. Providers register themselves via
 * `ctx.registerPaymentProvider(...)`. The `code` is the operator-facing
 * identifier (e.g. `"midtrans"`, `"xendit"`); the platform stores it on
 * the `payments` row so refunds and webhook callbacks route back to the
 * right provider after a process restart.
 */
export interface PaymentProvider {
  /** Stable, lowercase identifier. Must be unique across loaded plugins. */
  readonly code: string;
  /** Operator-facing display name. */
  readonly displayName: string;

  /** Begin a payment. Idempotent on `intent.idempotencyKey`. */
  initiate(intent: PaymentIntentLike): Promise<PaymentInitiateResult>;

  /**
   * Capture an authorized payment. Optional — providers that auto-capture
   * on initiate can omit this and the platform skips the call.
   */
  capture?(intent: PaymentIntentLike): Promise<PaymentCaptureResult>;

  /**
   * Refund a captured payment. `amount` defaults to the full captured
   * amount when omitted; partial refunds pass an explicit Money.
   */
  refund(intent: PaymentIntentLike, amount?: Money): Promise<PaymentRefundResult>;

  /**
   * Verify the signature on an incoming webhook. The platform calls this
   * BEFORE parsing or trusting any field of `rawBody`; a `false` return
   * causes the webhook handler to respond 401 without dispatching.
   *
   * `rawBody` is the unparsed request body as received over the wire.
   * `headers` is the case-insensitive header map; providers look up their
   * own signature header (e.g. `x-callback-token`).
   */
  verifyWebhookSignature(input: {
    rawBody: string;
    headers: Record<string, string>;
  }): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Shipping provider — plugin contract.
// ---------------------------------------------------------------------------

/**
 * Structural subset of a shipping method that providers rely on. The api
 * `ShippingMethod` (with ids, timestamps, soft-delete) extends this — the
 * provider only needs the fields below to compute a quote.
 */
export interface ShippingMethodLike {
  readonly code: string;
  readonly providerKind: "manual" | "plugin";
  readonly flatRate: Money | null;
}

/**
 * Shipping provider plugin interface. A plugin shipping provider registers
 * with a unique `code`; the api's shipping service routes a method whose
 * row stores `provider_kind = 'plugin'` to the provider whose `code`
 * matches the method's `code` (one provider per method code).
 *
 * `quote` returns a `Money` whose currency MUST equal `opts.currency`. The
 * service double-checks at the boundary; providers should also throw
 * eagerly with a clear domain error when the method cannot quote in the
 * requested currency.
 */
export interface ShippingProvider {
  /** Stable identifier, matching the `code` on the shipping method row. */
  readonly code: string;
  /** Operator-facing display name. */
  readonly displayName: string;
  quote(
    method: ShippingMethodLike,
    opts: { currency: string },
  ): Promise<Money>;
}

// ---------------------------------------------------------------------------
// Notification channel — plugin contract.
// ---------------------------------------------------------------------------

/**
 * Input handed to a notification channel's `send`. The platform renders
 * the template before dispatch; the channel only handles transport.
 *
 * Mirrors the api's `ChannelSendInput` shape so a plugin channel and a
 * built-in channel are interchangeable.
 *
 * `payload` and `locale` are forwarded for channels that need the
 * structured data behind the rendered text — operator-approved template
 * channels (WhatsApp Business, Twilio Verify) build their wire request
 * from positional/named variables, not free-form body text. Email-shaped
 * channels (smtp, console) MAY ignore them.
 */
export interface NotificationChannelSendInput {
  /** Email address, phone number, push token — depends on the channel. */
  readonly recipient: string;
  /**
   * The notification kind, for metrics/audit. Channels MAY ignore it.
   * Typed as `string` here so a plugin can introduce new kinds without
   * editing core; the api validates known kinds at the service layer.
   */
  readonly kind: string;
  readonly subject?: string;
  readonly body: string;
  readonly htmlBody?: string;
  /**
   * The structured template payload that produced `body`/`htmlBody`. Set
   * by the platform when the kind is one of the built-in templated kinds;
   * `undefined` for ad-hoc sends. Plugin channels that drive
   * operator-approved templates (WhatsApp, push) read from this directly
   * rather than parsing the rendered body.
   */
  readonly payload?: Record<string, unknown>;
  /**
   * Locale the platform rendered against. Channels that resolve their own
   * upstream template name per language (Meta WhatsApp Cloud requires a
   * `language.code`) consult this; the rendered body is already in the
   * matching locale.
   */
  readonly locale?: string;
}

/**
 * Notification channel plugin interface. Channels register with a unique
 * `id` (e.g. `"sms"`, `"push"`, `"whatsapp-cloud"`); callers route by id
 * via `notificationService.send({ channel: 'sms', ... })`.
 *
 * `send` MUST throw on transport failure so the service can record the
 * failure to the audit row.
 */
export interface NotificationChannel {
  readonly id: string;
  send(input: NotificationChannelSendInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Domain events — names and payloads exposed to plugins.
// ---------------------------------------------------------------------------

/**
 * The set of events plugins can subscribe to. This map is the union of
 * every module-local event bus's payload map, projected into core so
 * plugins do not have to import from `@mt-commerce/api`.
 *
 * Adding a new event:
 *   1. Define it on the originating module's local bus (e.g.
 *      `apps/api/src/modules/orders/events.ts`).
 *   2. Add the same `name -> payload` entry here.
 *   3. The api's plugin loader bridges the subscription to the right bus
 *      via the dot-prefix on the event name.
 *
 * Payload shapes are deliberately structural (string ids, decimal-string
 * money) so they survive a plugin author building against `@mt-commerce/core`
 * at a different patch version than the api is running.
 */
export interface DomainEventMap {
  // ---- checkout ---------------------------------------------------------
  "checkout.started": { checkoutId: string; cartId: string };
  "checkout.shipping_set": {
    checkoutId: string;
    shippingMethodCode: string;
  };
  "checkout.payment_initiated": {
    checkoutId: string;
    paymentMethod: string;
  };
  "checkout.completed": {
    checkoutId: string;
    orderIntentId: string;
    cartId: string;
  };
  "checkout.failed": {
    checkoutId: string;
    reason: string | null;
  };

  // ---- orders -----------------------------------------------------------
  "order.placed": {
    orderId: string;
    orderNumber: string;
    customerId: string | null;
    email: string;
    /** Total in the smallest unit of `currency`, decimal string. */
    totalAmount: string;
    currency: string;
  };
  "order.paid": {
    orderId: string;
    orderNumber: string;
  };
  "order.fulfilled": {
    orderId: string;
    orderNumber: string;
  };
  "order.cancelled": {
    orderId: string;
    orderNumber: string;
    reason: string | null;
  };
  "order.refunded": {
    orderId: string;
    orderNumber: string;
  };

  // ---- payments ---------------------------------------------------------
  /**
   * A captured payment. Emitted by the payments module after the provider
   * confirms the funds movement and the `payments` row transitions to
   * `captured`. The notification module renders `payment_received` against
   * this event; future plugins (analytics, accounting export) attach the
   * same way.
   *
   * `provider` carries the provider code (`midtrans`, `xendit`, ...) the
   * payment was settled through — not the operator-facing payment method
   * label on the order. Plugin listeners that branch on which provider
   * captured (e.g. provider-specific reconciliation) read this directly;
   * notifications consult the order's `paymentMethod` instead.
   */
  "payment.captured": {
    paymentId: string;
    orderId: string;
    provider: string;
  };

  // ---- shipping ---------------------------------------------------------
  /**
   * A fulfillment that has been handed to the courier. Emitted by the
   * shipping module on the `pending → shipped` transition (admin
   * `mark-shipped`, or a future plugin webhook). `trackingCode` is null
   * when the operator marked shipped without a code — the platform does
   * not block the transition on a missing code (couriers issue codes
   * asynchronously in some flows). The notification module's
   * `shipping_update` template omits the tracking line when it is null.
   */
  "fulfillment.shipped": {
    fulfillmentId: string;
    orderId: string;
    trackingCode: string | null;
  };
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEventPayload<E extends DomainEventName> = DomainEventMap[E];

// ---------------------------------------------------------------------------
// Plugin context — the surface a plugin sees inside `setup(ctx)`.
// ---------------------------------------------------------------------------

/**
 * The handle a plugin uses inside `setup(ctx)` to wire itself into the
 * platform. Every method is synchronous; the plugin's setup as a whole
 * may be async (`setup` itself can return a promise).
 *
 * Naming convention:
 *   - `registerXxx` — adds an item to a registry. Throws on duplicate
 *     identifiers (`code` for payment/shipping, `id` for channels).
 *   - `on` — subscribes to a typed domain event. Returns an unsubscribe
 *     function the plugin MAY return from setup as the "uninstall" hook.
 */
export interface PluginContext {
  /** Register a payment provider. Throws if `provider.code` is already taken. */
  registerPaymentProvider(provider: PaymentProvider): void;
  /** Register a shipping provider. Throws on duplicate `code`. */
  registerShippingProvider(provider: ShippingProvider): void;
  /** Register a notification channel. Throws on duplicate `id`. */
  registerNotificationChannel(channel: NotificationChannel): void;
  /**
   * Subscribe to a typed domain event. Returns an unsubscribe function;
   * the plugin's `setup` MAY return this (or an array's combinator) so
   * the loader can detach the listener on shutdown.
   */
  on<E extends DomainEventName>(
    event: E,
    listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
  ): () => void;

  /** Logger scoped to the plugin (`{ plugin: "<name>" }`). */
  readonly log: PluginLogger;
  /**
   * The configuration the operator passed to the plugin's factory in
   * `mt-commerce.config.ts`. Plugin authors typically read this from
   * closure inside their factory — but the loader also surfaces it on
   * `ctx.config` so a `definePlugin`-only (no factory) plugin can still
   * receive operator config via the `config` property the loader sets.
   */
  readonly config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin manifest + factories.
// ---------------------------------------------------------------------------

/**
 * The shape `definePlugin` accepts and returns. Plugin authors typically
 * wrap this in a factory that takes operator options:
 *
 *   export default function myPlugin(opts: { apiKey: string }) {
 *     return definePlugin({
 *       name: "@my-org/payment-foo",
 *       version: "1.0.0",
 *       setup(ctx) {
 *         ctx.registerPaymentProvider(new FooProvider(opts));
 *       },
 *     });
 *   }
 *
 * The factory pattern keeps operator config out of the manifest's static
 * shape — which means plugins can validate options eagerly in their own
 * factory rather than dragging Zod into the loader.
 */
export interface Plugin {
  /**
   * Stable identifier for logs and the loader's manifest. Use the npm
   * package name (e.g. `"@my-org/payment-foo"`); the loader logs it on
   * load/unload and uses it in error messages.
   */
  readonly name: string;
  /** Semver. Surfaced in the loader log line. */
  readonly version: string;
  /**
   * Called once at API boot. Receives the registries and event bus via
   * `ctx`. May return:
   *   - `void` (most plugins)
   *   - a teardown function (called on graceful shutdown — currently a
   *     no-op in v0.1, reserved for future use)
   *   - a `Promise` resolving to either of the above
   */
  setup(
    ctx: PluginContext,
  ):
    | void
    | Promise<void>
    | (() => void | Promise<void>)
    | Promise<() => void | Promise<void>>;
}

/**
 * Identity helper. Exists so plugin authors get inference and a single
 * import surface; the loader does not require plugins to call this (a
 * raw object literal that satisfies `Plugin` works), but using it makes
 * type errors land at the manifest rather than at registration time.
 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

// ---------------------------------------------------------------------------
// Operator config (`mt-commerce.config.ts`).
// ---------------------------------------------------------------------------

/**
 * Shape of the file the operator places at `apps/api/mt-commerce.config.ts`
 * (or, fallback, the workspace root). The loader reads it via dynamic
 * import; missing file → empty plugin list.
 *
 * Future fields (not in v0.1): `database.url`, `redis.url`, `cors.origin`
 * — currently sourced from environment variables. Adding them here later
 * is additive.
 */
export interface MtCommerceConfig {
  /**
   * Loaded plugins, in registration order. Each entry is the value
   * returned by a plugin's factory (or by `definePlugin` directly when
   * the plugin takes no options).
   */
  readonly plugins?: readonly Plugin[];
}

/**
 * Identity helper for `mt-commerce.config.ts`. Exists for type inference
 * and for symmetry with `definePlugin`; the loader does NOT require
 * `defineConfig` (a default-exported object satisfying `MtCommerceConfig`
 * works), but using it surfaces config errors at the file rather than at
 * boot.
 */
export function defineConfig(config: MtCommerceConfig): MtCommerceConfig {
  return config;
}

/**
 * `NotificationService` — public contract for the notification module.
 *
 * Responsibilities:
 *
 *   1. Pick the right channel adapter for a `(channel, kind)` pair. The
 *      registry is built once at construction; the service does not look up
 *      channels by string at every send call.
 *
 *   2. Persist an audit row BEFORE handing off to the channel. The row
 *      starts at `status='pending'`. If the channel throws, the row is
 *      updated to `failed` with `error_message` set; on success it
 *      transitions to `sent`. Persisting first is deliberate — a channel
 *      that crashes the process (rare but possible with nodemailer
 *      transports holding sockets) still leaves an audit trail.
 *
 *   3. Render templates. The renderer is pure and bilingual; the service
 *      hands the channel the rendered triple `{ subject, body, htmlBody }`.
 *
 *   4. Subscribe to in-process events on app boot. `subscribeToEvents()`
 *      wires the cross-module reactions: `checkout.completed` →
 *      `order_confirmation` email. Listeners are idempotent at the audit-
 *      row level (the audit row's id is fresh per emit).
 *
 * Failure handling:
 *   - The `send(...)` method NEVER throws on a channel error in the
 *     fire-and-forget event-listener path. `sendOrThrow(...)` is the
 *     "request-path" sibling auth uses for verification email — auth
 *     wants to surface the failure to the signup HTTP response so the
 *     client can show "we could not send your verification email" rather
 *     than silently succeed.
 */
import { id } from "@mt-commerce/core/ulid";
import type { NotificationChannel as PluginNotificationChannel } from "@mt-commerce/core/plugin";
import { env } from "../../lib/env.js";
import { childLogger } from "../../lib/logger.js";
import { ConflictError } from "../../lib/errors.js";
import { events as checkoutEvents } from "../checkout/events.js";
// IMPORTANT: only `type`-level imports from sibling modules. The
// notification module is reached at module-evaluation time by the auth
// module (`auth/better-auth.ts` imports `getNotificationService` for the
// verification-email path). The orders / customer / shipping module
// chains depend on the auth middleware. Eagerly importing their value
// surfaces here would close a cycle and break middleware resolution at
// boot — the runtime singletons resolve LAZILY inside `subscribeToEvents`
// instead, when every module has finished evaluating.
import type { CustomerService } from "../customer/service.js";
import { events as orderEvents } from "../orders/events.js";
import type { OrderService } from "../orders/service.js";
import type { Order } from "../orders/types.js";
import { events as paymentEvents } from "../payments/events.js";
import { events as fulfillmentEvents } from "../shipping/events.js";
import type { NotificationChannel } from "./channels/types.js";
import { ConsoleEmailChannel } from "./channels/console.js";
import { createEmailChannel } from "./channels/smtp.js";
import { WhatsappStubChannel } from "./channels/whatsapp-stub.js";
import { toNotification } from "./mappers.js";
import {
  createNotificationRepository,
  type NotificationRepository,
} from "./repository.js";
import {
  renderEmailVerification,
  renderOrderConfirmation,
  renderPasswordReset,
  renderPaymentReceived,
  renderShippingUpdate,
  type RenderedTemplate,
} from "./templates/index.js";
import {
  DEFAULT_NOTIFICATION_LOCALE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListNotificationsQuery,
  type Notification,
  type NotificationAddress,
  type NotificationChannelId,
  type NotificationLineItem,
  type NotificationLocale,
  type NotificationMoney,
  type NotificationPayload,
  type NotificationResult,
  type NotificationTotals,
  type OrderConfirmationPayload,
  type Paginated,
  type SendInput,
} from "./types.js";

const log = childLogger("notification");

export interface NotificationService {
  /**
   * Fire-and-forget send. Returns a `NotificationResult` whether the
   * channel succeeded or failed; callers inspect `notification.status` to
   * branch. Used by the event-listener path where surfacing a failure to
   * an HTTP caller does not apply.
   */
  send(input: SendInput): Promise<NotificationResult>;

  /**
   * Send-or-throw variant. Throws when the channel adapter rejects so
   * a request-path caller (e.g. auth's `sendVerificationEmail`) can
   * fail the originating HTTP request. The audit row is persisted in
   * either branch.
   */
  sendOrThrow(input: SendInput): Promise<NotificationResult>;

  listSent(
    filter: Omit<ListNotificationsQuery, "page" | "pageSize">,
    opts?: { page?: number; pageSize?: number },
  ): Promise<Paginated<Notification>>;

  /**
   * Wire in-process event listeners. The app calls this once after
   * construction. Calling it more than once is a no-op (the underlying
   * bus deduplicates by listener function identity, but we also guard
   * via an internal flag).
   */
  subscribeToEvents(): void;

  /**
   * Register a plugin-supplied notification channel keyed by `channel.id`.
   * Plugin channel ids are open strings (e.g. `"sms"`, `"push"`,
   * `"whatsapp-cloud"`) and live in a separate sub-registry from the
   * built-in `'email' | 'whatsapp'` ids; lookups in `send` consult both.
   *
   * Throws `ConflictError` when a channel with the same id is already
   * registered (built-in or plugin). The plugin loader catches and surfaces
   * this as a clean "duplicate channel" boot diagnostic.
   */
  registerChannel(channel: PluginNotificationChannel): void;
}

export interface NotificationServiceOptions {
  repository?: NotificationRepository;
  /**
   * Pre-built channel registry. Used by tests to inject fakes. Production
   * code lets the service construct the default registry (console + SMTP +
   * whatsapp-stub).
   */
  channels?: Map<NotificationChannelId, NotificationChannel>;
  /**
   * Order/customer services used by the event listeners to resolve full
   * order details + customer contact info. Defaults to LAZY resolution
   * of the runtime singletons inside the listener body — see
   * `resolveOrderService` / `resolveCustomerService`. Tests pass
   * concrete fakes here so listener wiring can be exercised without
   * standing up the orders / customer modules' DB layers.
   *
   * Why lazy: the auth module imports `getNotificationService` at
   * module-evaluation time. If this constructor eagerly imported
   * `orderService` / `customerService` from those modules, the eval-time
   * dependency graph would close a cycle through the shipping/customer
   * route builders → auth middleware → back into notification. Pushing
   * resolution to call time avoids the cycle without introducing any
   * runtime cost (the resolver caches after the first lookup).
   */
  orderService?: OrderService;
  customerService?: CustomerService;
}

export class NotificationServiceImpl implements NotificationService {
  private readonly repo: NotificationRepository;
  private readonly channels: Map<NotificationChannelId, NotificationChannel>;
  /**
   * Plugin-supplied channels keyed by their open-string `id`. Looked up
   * after the built-in registry misses; this keeps plugin authors from
   * accidentally shadowing the canonical email/whatsapp ids while still
   * letting them introduce wholly new channel ids.
   */
  private readonly pluginChannels = new Map<string, PluginNotificationChannel>();
  /**
   * Lazily-resolved order/customer service handles. `undefined` means
   * "fall through to the runtime singleton at first use". Tests inject a
   * concrete value via the constructor; production lets the listener
   * resolve through the dynamic-import helpers below to avoid the
   * module-evaluation cycle described on `NotificationServiceOptions`.
   */
  private orderServiceOverride: OrderService | undefined;
  private customerServiceOverride: CustomerService | undefined;
  private cachedOrderService: OrderService | undefined;
  private cachedCustomerService: CustomerService | undefined;
  private subscribed = false;

  constructor(options: NotificationServiceOptions = {}) {
    this.repo = options.repository ?? createNotificationRepository();
    this.channels = options.channels ?? buildDefaultChannels();
    this.orderServiceOverride = options.orderService;
    this.customerServiceOverride = options.customerService;
  }

  /**
   * Resolve the OrderService at listener invocation time. Cached after the
   * first call so we do not pay the dynamic-import cost on every event.
   * Tests that inject via the constructor short-circuit the dynamic
   * import entirely.
   */
  private async resolveOrderService(): Promise<OrderService> {
    if (this.orderServiceOverride) return this.orderServiceOverride;
    if (this.cachedOrderService) return this.cachedOrderService;
    const mod = await import("../orders/service.js");
    this.cachedOrderService = mod.orderService;
    return this.cachedOrderService;
  }

  private async resolveCustomerService(): Promise<CustomerService> {
    if (this.customerServiceOverride) return this.customerServiceOverride;
    if (this.cachedCustomerService) return this.cachedCustomerService;
    const mod = await import("../customer/service.js");
    this.cachedCustomerService = mod.customerService;
    return this.cachedCustomerService;
  }

  registerChannel(channel: PluginNotificationChannel): void {
    if (this.channels.has(channel.id as NotificationChannelId)) {
      throw new ConflictError(
        "Built-in notification channel with this id already exists.",
        { id: channel.id },
      );
    }
    if (this.pluginChannels.has(channel.id)) {
      throw new ConflictError(
        "Plugin notification channel with this id is already registered.",
        { id: channel.id },
      );
    }
    this.pluginChannels.set(channel.id, channel);
  }

  async send(input: SendInput): Promise<NotificationResult> {
    return this.sendInternal(input, { rethrow: false });
  }

  async sendOrThrow(input: SendInput): Promise<NotificationResult> {
    return this.sendInternal(input, { rethrow: true });
  }

  /**
   * Shared send body. The `rethrow` flag is the only difference between
   * the two public methods; we keep them as separate names because the
   * call sites read very differently ("send and forget" vs "send or
   * fail the request").
   *
   * Idempotency: when `input.eventId` is set, the INSERT may collide on the
   * partial unique index `notifications_event_kind_channel_uniq`. We catch
   * the 23505, look up the existing row, and return it without dispatching
   * to the channel a second time. This is the at-least-once guard for the
   * event-listener path — the bus may re-deliver, an upstream webhook may
   * retry, and we MUST NOT email a customer twice on a duplicate event.
   */
  private async sendInternal(
    input: SendInput,
    options: { rethrow: boolean },
  ): Promise<NotificationResult> {
    const channelId = input.channel ?? defaultChannelForKind(input.message.kind);
    // Built-in registry first; fall through to plugin sub-registry. Both
    // implementations satisfy the same `NotificationChannel` contract from
    // the channel's perspective (the api `NotificationChannel` type has the
    // same shape as `@mt-commerce/core`'s `NotificationChannel`), so the
    // call site does not branch on which registry won.
    const channel: NotificationChannel | PluginNotificationChannel | undefined =
      this.channels.get(channelId) ?? this.pluginChannels.get(channelId);
    const rendered = render(input.message, input.locale);

    const auditId = id("notif");
    let initial;
    try {
      // INSERT first so a process crash mid-send still leaves a row. The
      // row carries the rendered subject (not the body — bodies are large
      // and re-derivable) plus the template variables for replay/debug.
      initial = await this.repo.insert({
        id: auditId,
        channel: channelId,
        kind: input.message.kind,
        recipient: input.recipient,
        subject: rendered.subject,
        // Discriminated payload narrows on `kind`; persisting it in the
        // jsonb `payload` column requires the loose Record shape. Cast via
        // `unknown` because the payload's structural type does not include
        // a string index signature.
        payload: input.message.payload as unknown as Record<string, unknown>,
        status: "pending",
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
      });
    } catch (err) {
      // Duplicate event delivery: the partial unique index rejected the
      // insert. Surface the existing row instead of dispatching a second
      // time. The `rethrow` flag does NOT apply here — duplicate suppression
      // is by design for both the fire-and-forget and request-path callers
      // (a request-path caller that hands us an `eventId` is opting in
      // explicitly to the same idempotency contract).
      if (
        input.eventId !== undefined &&
        isPostgresUniqueViolation(
          err,
          "notifications_event_kind_channel_uniq",
        )
      ) {
        const existing = await this.repo.getByEventTriple(
          input.eventId,
          input.message.kind,
          channelId,
        );
        if (existing) {
          log.info(
            {
              eventId: input.eventId,
              kind: input.message.kind,
              channel: channelId,
              existingId: existing.id,
              existingStatus: existing.status,
            },
            "notification suppressed — duplicate event delivery",
          );
          return { notification: toNotification(existing) };
        }
        // Race the index won but the row vanished (e.g. an admin DELETE
        // mid-flight): fall through and surface the original error.
      }
      throw err;
    }

    if (!channel) {
      // No registered channel for this id. Mark failed; do not throw on
      // the fire-and-forget path so a misconfigured event listener does
      // not crash the emitter.
      const message = `No channel registered for "${channelId}".`;
      const updated = await this.repo.markStatus(auditId, "failed", message);
      log.error(
        { auditId, channel: channelId, kind: input.message.kind },
        message,
      );
      if (options.rethrow) throw new Error(message);
      return { notification: toNotification(updated ?? initial) };
    }

    try {
      await channel.send({
        recipient: input.recipient,
        kind: input.message.kind,
        subject: rendered.subject,
        body: rendered.body,
        htmlBody: rendered.htmlBody,
        // Forward the structured payload + locale so plugin channels
        // that drive operator-approved templates (WhatsApp, push) can
        // build their wire request without parsing the rendered text.
        // Email-shaped channels ignore both fields.
        payload: input.message.payload as unknown as Record<string, unknown>,
        ...(input.locale ? { locale: input.locale } : {}),
      });
      const updated = await this.repo.markStatus(auditId, "sent", null);
      return { notification: toNotification(updated ?? initial) };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "channel adapter threw";
      const updated = await this.repo.markStatus(auditId, "failed", message);
      log.error(
        {
          auditId,
          channel: channelId,
          kind: input.message.kind,
          err,
        },
        "notification send failed",
      );
      if (options.rethrow) throw err;
      return { notification: toNotification(updated ?? initial) };
    }
  }

  async listSent(
    filter: Omit<ListNotificationsQuery, "page" | "pageSize">,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<Paginated<Notification>> {
    const page = clampPage(opts.page);
    const pageSize = clampPageSize(opts.pageSize);
    const { rows, total } = await this.repo.list({
      ...(filter.channel ? { channel: filter.channel } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      page,
      pageSize,
    });
    return {
      data: rows.map(toNotification),
      total,
      page,
      pageSize,
    };
  }

  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    // checkout.completed remains a logging-only listener — the orders
    // module is the canonical emitter for "an order was placed". Keeping
    // the subscriber here so an operator searching for "checkout.completed"
    // in code sees the explicit no-op rather than wondering whether the
    // hook ever existed.
    checkoutEvents.on("checkout.completed", async (payload) => {
      log.debug(
        {
          checkoutId: payload.checkoutId,
          orderIntentId: payload.orderIntentId,
        },
        "checkout.completed observed (no notification — order.placed drives the email)",
      );
    });

    // order.placed → order_confirmation. Fired by the orders module after
    // the order materialises from an order_intent (post-commit). The
    // listener loads the full order to render line items, totals, and the
    // shipping address — those fields are not on the event payload
    // because the bus's purpose is to broadcast a fact, not a full
    // snapshot.
    orderEvents.on("order.placed", async (payload) => {
      await this.handleEvent(
        eventIdFor("order.placed", payload.orderId),
        () => this.dispatchOrderConfirmation(payload),
        { event: "order.placed", orderId: payload.orderId },
      );
    });

    // payment.captured → payment_received. Same shape as above; we look
    // up the order to read the payment method label (the event carries
    // the provider code, which is too low-level for a customer-facing
    // body) plus the email recipient.
    paymentEvents.on("payment.captured", async (payload) => {
      await this.handleEvent(
        eventIdFor("payment.captured", payload.paymentId),
        () => this.dispatchPaymentReceived(payload),
        {
          event: "payment.captured",
          orderId: payload.orderId,
          paymentId: payload.paymentId,
        },
      );
    });

    // fulfillment.shipped → shipping_update. Carries the tracking code
    // (nullable — operators can mark shipped before the courier returns
    // a code).
    fulfillmentEvents.on("fulfillment.shipped", async (payload) => {
      await this.handleEvent(
        eventIdFor("fulfillment.shipped", payload.fulfillmentId),
        () => this.dispatchShippingUpdate(payload),
        {
          event: "fulfillment.shipped",
          orderId: payload.orderId,
          fulfillmentId: payload.fulfillmentId,
        },
      );
    });
  }

  // -------------------------------------------------------------------
  // Listener internals
  // -------------------------------------------------------------------

  /**
   * Wrap a listener body so a thrown exception is caught + logged and
   * never propagates. The originating bus already catches per-listener
   * throws (see `events.ts`), but we double-belt-and-suspenders here:
   *
   *   - The bus runs under the post-commit `emitPending` of the upstream
   *     domain operation (orders/payments/shipping). The order is already
   *     written; a notification glitch MUST NOT crash the emit loop or
   *     prevent another listener (analytics, audit) from running.
   *
   *   - A `logger.error` on the notification side gives operators a
   *     direct grep target ("notification listener failed event=...") that
   *     is more specific than the generic bus error line.
   */
  private async handleEvent(
    _eventId: string,
    body: () => Promise<void>,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await body();
    } catch (err) {
      log.error(
        { err, ...context },
        "notification listener failed (suppressed; upstream commit retained)",
      );
    }
  }

  /**
   * Build the `order_confirmation` payload from the full order row and
   * dispatch via email (and, best-effort, WhatsApp). A guest checkout
   * (`customerId === null`) falls back to the order's email + the
   * shipping address phone.
   */
  private async dispatchOrderConfirmation(payload: {
    orderId: string;
    customerId: string | null;
    email: string;
  }): Promise<void> {
    const orderService = await this.resolveOrderService();
    const order = await orderService.getOrderById(payload.orderId);
    if (!order) {
      // Order disappeared between event emit and listener run — a deletion
      // race that should not happen in v0.1 (orders are not hard-deleted)
      // but logging the gap surfaces it cleanly.
      log.warn(
        { orderId: payload.orderId },
        "order.placed received but order not found — skipping notification",
      );
      return;
    }

    const contact = await this.resolveContact(order, payload);
    const message = buildOrderConfirmationPayload(order);

    await this.send({
      channel: "email",
      recipient: contact.email,
      locale: contact.locale,
      message: { kind: "order_confirmation", payload: message },
      eventId: eventIdFor("order.placed", order.id),
    });

    // Best-effort WhatsApp dispatch. Skipped when the customer has no
    // phone or the registered WhatsApp channel is the v0.1 stub (the stub
    // throws and we'd burn an audit row on every order). A plugin-loaded
    // WhatsApp channel will register over the stub via `registerChannel`.
    if (contact.phone && this.hasNonStubWhatsappChannel()) {
      await this.send({
        channel: "whatsapp",
        recipient: contact.phone,
        locale: contact.locale,
        message: { kind: "order_confirmation", payload: message },
        eventId: eventIdFor("order.placed", order.id),
      });
    }
  }

  private async dispatchPaymentReceived(payload: {
    orderId: string;
    paymentId: string;
  }): Promise<void> {
    const orderService = await this.resolveOrderService();
    const order = await orderService.getOrderById(payload.orderId);
    if (!order) {
      log.warn(
        { orderId: payload.orderId, paymentId: payload.paymentId },
        "payment.captured received but order not found — skipping notification",
      );
      return;
    }

    const contact = await this.resolveContact(order, {
      customerId: order.customerId,
      email: order.email,
    });

    await this.send({
      channel: "email",
      recipient: contact.email,
      locale: contact.locale,
      message: {
        kind: "payment_received",
        payload: {
          orderId: order.orderNumber,
          amount: moneyToTemplate(order.total),
          // `paymentMethod` on the order is the operator-facing label the
          // customer chose at checkout (e.g. "manual_transfer", or the
          // provider code stored verbatim). We pass it through; templates
          // do not editorialise.
          paymentMethod: order.paymentMethod,
        },
      },
      eventId: eventIdFor("payment.captured", payload.paymentId),
    });
  }

  private async dispatchShippingUpdate(payload: {
    fulfillmentId: string;
    orderId: string;
    trackingCode: string | null;
  }): Promise<void> {
    const orderService = await this.resolveOrderService();
    const order = await orderService.getOrderById(payload.orderId);
    if (!order) {
      log.warn(
        { orderId: payload.orderId, fulfillmentId: payload.fulfillmentId },
        "fulfillment.shipped received but order not found — skipping notification",
      );
      return;
    }

    const contact = await this.resolveContact(order, {
      customerId: order.customerId,
      email: order.email,
    });

    await this.send({
      channel: "email",
      recipient: contact.email,
      locale: contact.locale,
      message: {
        kind: "shipping_update",
        payload: {
          orderId: order.orderNumber,
          trackingCode: payload.trackingCode,
          // The fulfillment lifecycle is `pending → shipped → delivered`;
          // this listener fires on the `shipped` transition, so the wire
          // status is fixed here. Localised label resolution lives in the
          // template.
          status: "shipped",
          estimatedDelivery: null,
        },
      },
      eventId: eventIdFor("fulfillment.shipped", payload.fulfillmentId),
    });
  }

  /**
   * Resolve the customer's contact channels and locale.
   *
   * Resolution order:
   *
   *   1. If the order has a `customerId`, look up the customer record for
   *      `phone` (and, in the future, `locale`). The customer's email is
   *      the system of record for account holders.
   *   2. Guest checkouts (`customerId === null`) use the email captured on
   *      the order and the shipping address's phone — neither field can
   *      be back-filled from a customer row.
   *   3. Locale defaults to `id` (the project default per
   *      `DEFAULT_NOTIFICATION_LOCALE`). The `Customer` row does not yet
   *      carry a `locale` column; the brief flagged it as a future
   *      addition. Threading it through the listener now keeps the
   *      template arg honest the day the column lands.
   */
  private async resolveContact(
    order: Order,
    payload: { customerId: string | null; email: string },
  ): Promise<{ email: string; phone: string | null; locale: NotificationLocale }> {
    let phone: string | null = null;
    let locale: NotificationLocale = DEFAULT_NOTIFICATION_LOCALE;

    if (payload.customerId) {
      try {
        const customerService = await this.resolveCustomerService();
        const customer = await customerService.getCustomerById(
          payload.customerId,
        );
        if (customer) {
          phone = customer.phone ?? null;
          // Forward-compat: read `locale` off the Customer if/when the
          // column is added. The cast keeps the property-access defensive
          // — today it is always undefined.
          const candidate = (customer as unknown as { locale?: string })
            .locale;
          locale = normaliseLocale(candidate);
        }
      } catch (err) {
        // A customer-lookup failure should NOT prevent the notification:
        // we still have the order's email (for account holders, the same
        // value the customer record would yield) and we fall back to the
        // shipping address phone for WhatsApp. Logged so the operator can
        // see the lookup gap.
        log.warn(
          { err, customerId: payload.customerId, orderId: order.id },
          "customer lookup failed — falling back to order-side contact info",
        );
      }
    }

    // Guest fallback / customer-without-phone fallback — pull the phone
    // from the shipping address snapshot. Always present on the order
    // (the snapshot is captured at order materialisation).
    if (!phone) {
      phone = order.shippingAddressSnapshot?.phone ?? null;
    }

    return {
      email: payload.email,
      phone,
      locale,
    };
  }

  /**
   * Returns true when the registered `whatsapp` channel is something
   * other than the v0.1 stub (i.e. a plugin actually wired delivery).
   * The default registry installs `WhatsappStubChannel`, which throws on
   * every send — attempting WhatsApp dispatch with the stub installed
   * would burn a `failed` audit row for every order placed. We treat
   * that as "feature not configured" and skip silently.
   */
  private hasNonStubWhatsappChannel(): boolean {
    const registered = this.channels.get("whatsapp");
    return Boolean(registered) && !(registered instanceof WhatsappStubChannel);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the conventional channel for a given kind. Keeps callers from
 * having to spell out `channel: 'email'` every time, and keeps the door
 * open to per-kind routing later (e.g. shipping_update defaults to
 * WhatsApp once the plugin lands).
 */
function defaultChannelForKind(_kind: string): NotificationChannelId {
  return "email";
}

function render(
  message: NotificationPayload,
  locale: NotificationLocale | undefined,
): RenderedTemplate {
  // Discriminated dispatch — TypeScript narrows `message` per branch and
  // hands the renderer the matching payload type. Adding a kind without
  // a branch fails the exhaustiveness check at the `default` arm.
  switch (message.kind) {
    case "email_verification":
      return renderEmailVerification(message.payload, locale);
    case "order_confirmation":
      return renderOrderConfirmation(message.payload, locale);
    case "payment_received":
      return renderPaymentReceived(message.payload, locale);
    case "shipping_update":
      return renderShippingUpdate(message.payload, locale);
    case "password_reset":
      return renderPasswordReset(message.payload, locale);
    default: {
      // Exhaustiveness guard.
      const exhaustive: never = message;
      throw new Error(
        `unhandled notification kind: ${(exhaustive as { kind?: string }).kind ?? "<unknown>"}`,
      );
    }
  }
}

/**
 * Build the default channel registry. Reads `env.notificationDefaultChannel`
 * to decide whether the email entry is the console or the SMTP adapter;
 * the SMTP factory itself falls back to console when SMTP_HOST is missing
 * outside production. Both branches are wired so a caller passing
 * `channel: 'email'` always resolves.
 */
function buildDefaultChannels(): Map<
  NotificationChannelId,
  NotificationChannel
> {
  const channels = new Map<NotificationChannelId, NotificationChannel>();

  let emailChannel: NotificationChannel;
  if (env.notificationDefaultChannel === "console") {
    // Operator opted into console explicitly.
    emailChannel = new ConsoleEmailChannel();
  } else {
    // `smtp` (or unset, which maps to smtp in prod). The factory throws
    // in production when SMTP_HOST is missing — we let that escape so the
    // API refuses to start without explicit configuration.
    emailChannel = createEmailChannel();
  }
  channels.set("email", emailChannel);
  channels.set("whatsapp", new WhatsappStubChannel());
  return channels;
}

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Build the deterministic event-driven idempotency key. The format is
 * `event:<bus-event-name>:<primary-id>` — so a duplicate `order.placed`
 * delivery for `ord_abc` resolves to the same key on every retry.
 *
 * We use the order id (not the order number) because the id is the
 * canonical primary key and never reissued; the order number is also
 * unique but it is a customer-facing handle we'd rather keep out of
 * internal idempotency keys.
 */
function eventIdFor(eventName: string, primaryId: string): string {
  return `event:${eventName}:${primaryId}`;
}

/**
 * Reshape a domain `Order` into the `OrderConfirmationPayload` the
 * template renderer accepts. We use the customer-facing `orderNumber`
 * (not the internal `id`) for the body — that is what the customer
 * pastes into a support email — and we strip `Money` instances down to
 * `{ amount, currency }` strings on the wire (`bigint` does not survive
 * jsonb persistence cleanly, and the template formatter expects a
 * decimal-string contract).
 */
function buildOrderConfirmationPayload(order: Order): OrderConfirmationPayload {
  const items: NotificationLineItem[] = order.items.map((item) => ({
    name: item.title || item.sku,
    quantity: item.quantity,
    unitPrice: moneyToTemplate(item.unitPrice),
  }));

  const totals: NotificationTotals = {
    subtotal: moneyToTemplate(order.subtotal),
    tax: moneyToTemplate(order.tax),
    shipping: moneyToTemplate(order.shipping),
    total: moneyToTemplate(order.total),
  };

  const a = order.shippingAddressSnapshot;
  const shippingAddress: NotificationAddress = {
    recipientName: a.recipientName,
    phone: a.phone,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2 ?? null,
    // Prefer the resolved region NAME captured at order time (the
    // snapshot is self-contained per ADR-0010); fall back to the BPS
    // code when the snapshot pre-dates the name-capture rollout.
    city: a.kotaKabupatenName ?? a.kotaKabupatenId,
    province: a.provinsiName ?? a.provinsiId,
    postalCode: a.postalCode,
  };

  return {
    orderId: order.orderNumber,
    items,
    totals,
    shippingAddress,
  };
}

/**
 * Convert the `Money` value object (bigint amount) to the template's
 * wire-shape (`{ amount: string, currency: string }`). The template's
 * formatter operates on the decimal string — passing a bigint would
 * require it to know about bigints, which would leak the storage
 * representation across a layer boundary.
 */
function moneyToTemplate(money: { amount: bigint; currency: string }): NotificationMoney {
  return { amount: money.amount.toString(), currency: money.currency };
}

/**
 * Coerce an arbitrary string (or undefined) into a known
 * `NotificationLocale`, falling back to the project default. The
 * customer record may eventually carry a locale that drifts from the two
 * we ship templates for — defaulting to `id` rather than throwing keeps
 * the listener path robust against schema changes upstream.
 */
function normaliseLocale(candidate: string | undefined): NotificationLocale {
  if (candidate === "en" || candidate === "id") return candidate;
  return DEFAULT_NOTIFICATION_LOCALE;
}

/**
 * Narrow on the postgres-js (and node-postgres) `code` SQLSTATE field.
 * `23505` is `unique_violation`. When a constraint name is provided we
 * also match `constraint_name`, which postgres-js exposes alongside the
 * code. Used to detect duplicate event delivery on the partial unique
 * index `notifications_event_kind_channel_uniq` so we can return the
 * existing row rather than re-dispatching.
 *
 * Mirror of the helper in `checkout/service.ts`. Kept module-local
 * (rather than promoted to a shared lib) until at least three modules
 * need it — premature abstraction here would couple unrelated modules to
 * a single import.
 */
function isPostgresUniqueViolation(
  err: unknown,
  constraintName?: string,
): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as {
    code?: unknown;
    constraint_name?: unknown;
    constraint?: unknown;
  };
  if (candidate.code !== "23505") return false;
  if (!constraintName) return true;
  return (
    candidate.constraint_name === constraintName ||
    candidate.constraint === constraintName
  );
}

/**
 * Default singleton, lazy-constructed. The lazy guard means tests that
 * never touch this module do not pay the cost of constructing the
 * default channel registry (which would, in production mode, throw if
 * SMTP_HOST is missing).
 */
let defaultInstance: NotificationServiceImpl | undefined;
export function getNotificationService(): NotificationService {
  if (!defaultInstance) {
    defaultInstance = new NotificationServiceImpl();
  }
  return defaultInstance;
}

/**
 * Test-only — replace the default singleton. Tests that need to assert
 * behavior of the singleton itself (e.g. event-listener wiring) reset
 * this in `beforeEach`.
 */
export function __setNotificationServiceForTesting(
  override: NotificationServiceImpl | undefined,
): void {
  defaultInstance = override;
}

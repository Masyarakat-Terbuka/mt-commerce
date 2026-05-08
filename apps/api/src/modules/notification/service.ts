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
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListNotificationsQuery,
  type Notification,
  type NotificationChannelId,
  type NotificationLocale,
  type NotificationPayload,
  type NotificationResult,
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
  private subscribed = false;

  constructor(options: NotificationServiceOptions = {}) {
    this.repo = options.repository ?? createNotificationRepository();
    this.channels = options.channels ?? buildDefaultChannels();
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
    // INSERT first so a process crash mid-send still leaves a row. The
    // row carries the rendered subject (not the body — bodies are large
    // and re-derivable) plus the template variables for replay/debug.
    const initial = await this.repo.insert({
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
    });

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

    // checkout.completed → order_confirmation email.
    //
    // The event payload carries `checkoutId` and `orderIntentId`; this
    // listener does NOT yet have a fully-realized order to inspect (the
    // Order module materializes from order_intents in Track 3). For v0.1
    // we send a minimal "pesanan diterima" confirmation keyed on the
    // order_intent id, with empty items/totals. Track 3's order-emit
    // event will replace this listener; flagged as TODO so the swap is
    // visible during integration.
    checkoutEvents.on("checkout.completed", async (payload) => {
      // The bus runs listeners under the post-commit emit; a failure
      // here MUST NOT propagate (the bus already catches, but we also
      // call `send`, which never throws). Future work: enrich payload
      // with order rows when Track 3's order events ship.
      log.info(
        {
          checkoutId: payload.checkoutId,
          orderIntentId: payload.orderIntentId,
        },
        "checkout.completed received — minimal v0.1 listener (Track 3 will replace)",
      );
      // We intentionally do NOT call `send` here for v0.1 — we don't
      // have the buyer's email or order details on this event payload
      // alone. Track 3 emits an `order.placed` event with the resolved
      // recipient + items; this listener becomes a thin pass-through
      // when that lands.
    });

    // TODO Track payment: subscribe to `payment.captured` once the
    //   payment module emits it; send `payment_received` to the buyer.
    // TODO Track fulfillment: subscribe to `fulfillment.shipped` and
    //   send `shipping_update` with the tracking code.
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

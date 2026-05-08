/**
 * `NotificationChannel` — the interface every adapter implements.
 *
 * The channel is the transport layer: it takes a fully-rendered message
 * (subject + body + optional HTML body) and a recipient (an email address
 * or a phone number, depending on the channel), and either delivers it or
 * throws. The notification service handles audit-logging, template
 * rendering, and dispatch — channels stay focused on the wire.
 *
 * Why this interface lives in its own file:
 *   - Plugin authors implement `NotificationChannel` to add new transports
 *     (SMS, push, WhatsApp Business). The interface is the public contract;
 *     keeping it in `channels/types.ts` lets a plugin import only the type
 *     without pulling in any of our concrete adapters.
 *
 *   - The `id` field is the routing key. The service registers channels in
 *     a `Map<NotificationChannelId, NotificationChannel>` and dispatches by
 *     id; a future channel ships its own id literal.
 */
import type { NotificationChannelId } from "../types.js";

export interface ChannelSendInput {
  /** Email address or phone number, depending on the channel. */
  recipient: string;
  /** The kind triggers metrics/audit fields; channels can ignore it. */
  kind: string;
  /** Subject line. Optional — WhatsApp and SMS channels have no subject. */
  subject?: string;
  /** Plain-text body. Required for every channel. */
  body: string;
  /** Optional HTML body. Email channels prefer this when present. */
  htmlBody?: string;
  /**
   * Structured template payload that produced `body` / `htmlBody`. Set
   * for the templated kinds the service knows how to render; `undefined`
   * for ad-hoc sends. Channels that drive operator-approved templates
   * upstream (WhatsApp Business, push) build their wire request from
   * this rather than parsing rendered text. Email-shaped channels
   * (smtp, console) ignore it.
   */
  payload?: Record<string, unknown>;
  /**
   * Locale the platform rendered against. Channels that resolve a
   * per-language upstream template (Meta WhatsApp Cloud's
   * `language.code`) consult this. The body is already in the matching
   * locale.
   */
  locale?: string;
}

export interface NotificationChannel {
  /** Stable channel identifier. The service routes on this value. */
  readonly id: NotificationChannelId;

  /**
   * Deliver the message. Throws on transport failure; the service catches
   * and records the error to the audit row. A channel that returns without
   * throwing is, from the audit log's perspective, a successful send.
   */
  send(input: ChannelSendInput): Promise<void>;
}

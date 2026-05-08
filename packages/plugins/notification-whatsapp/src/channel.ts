/**
 * `WhatsappBusinessChannel` — concrete `NotificationChannel` for the
 * Meta WhatsApp Cloud API.
 *
 * Lifecycle:
 *
 *   1. Service hands us `(recipient, kind, payload, locale)` — `payload`
 *      and `locale` are the additive fields the platform forwards to
 *      structured-template channels (see core's
 *      `NotificationChannelSendInput`).
 *   2. We resolve the operator-configured template name for the kind. A
 *      missing entry throws `UnsupportedKindError` — no email fallback,
 *      no silent skip; the audit row should make it obvious that the
 *      operator forgot to register the template.
 *   3. We normalise the recipient phone to E.164-without-plus
 *      (`628123456789`).
 *   4. We map the structured payload to WhatsApp `components` via the
 *      kind-specific function in `templates.ts`.
 *   5. We POST to `https://graph.facebook.com/v20.0/{phoneNumberId}/messages`
 *      with bearer auth. A non-2xx surfaces as `ChannelDispatchError`
 *      with the parsed Meta error body attached.
 *
 * Idempotency:
 *   The notification service already dedupes on
 *   `(event_id, kind, channel)` via a partial unique index — this channel
 *   does NOT retry, does NOT set its own idempotency key, and does NOT
 *   inspect the audit log. A retry strategy would belong in the service
 *   (or an outbox), so it can be applied uniformly across channels.
 *
 * Why native `fetch`:
 *   - The plugin's quality bar excludes new top-level deps. Bun and
 *     Node 20+ ship `fetch` natively.
 *   - The channel is a thin adapter; `fetch` covers the wire and the
 *     status-code branching cleanly. No streaming, no multipart.
 */
import type {
  NotificationChannel,
  NotificationChannelSendInput,
  PluginLogger,
} from "@mt-commerce/core/plugin";
import { ChannelDispatchError, UnsupportedKindError } from "./errors.js";
import { resolveLocale, type WhatsappLocale } from "./locale.js";
import { normalizeIndonesianPhone } from "./phone.js";
import {
  buildOrderConfirmationComponents,
  buildPaymentReceivedComponents,
  buildShippingUpdateComponents,
  type OrderConfirmationPayload,
  type PaymentReceivedPayload,
  type ShippingUpdatePayload,
  type WhatsappTemplateComponent,
} from "./templates.js";

/** Kinds this channel can dispatch. Anything else throws `UnsupportedKindError`. */
export type WhatsappKind =
  | "order_confirmation"
  | "payment_received"
  | "shipping_update";

export interface WhatsappTemplateMap {
  /** Approved Meta template name for `order_confirmation`. */
  order_confirmation: string;
  /** Approved Meta template name for `payment_received`. */
  payment_received: string;
  /** Approved Meta template name for `shipping_update`. */
  shipping_update: string;
}

export interface WhatsappBusinessChannelOptions {
  phoneNumberId: string;
  accessToken: string;
  templates: WhatsappTemplateMap;
  /** Default locale when the platform does not pass one. Defaults `"id"`. */
  language?: WhatsappLocale;
  /**
   * Override fetch (test seam). Defaults to the global `fetch`. Production
   * never sets this; the channel and its tests are the only callers.
   */
  fetch?: typeof fetch;
  /**
   * Override the Graph API base URL. Useful for an integration test
   * pointing at a recorded sandbox; production never sets this.
   */
  graphBaseUrl?: string;
}

const DEFAULT_GRAPH_BASE = "https://graph.facebook.com/v20.0";

interface MessagesRequestBody {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components: WhatsappTemplateComponent[];
  };
}

export class WhatsappBusinessChannel implements NotificationChannel {
  readonly id = "whatsapp" as const;

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly templates: WhatsappTemplateMap;
  private readonly defaultLocale: WhatsappLocale;
  private readonly fetchImpl: typeof fetch;
  private readonly graphBaseUrl: string;

  constructor(
    options: WhatsappBusinessChannelOptions,
    private readonly log: PluginLogger,
  ) {
    if (!options.phoneNumberId) {
      throw new Error("WhatsappBusinessChannel: `phoneNumberId` is required.");
    }
    if (!options.accessToken) {
      throw new Error("WhatsappBusinessChannel: `accessToken` is required.");
    }
    if (
      !options.templates ||
      !options.templates.order_confirmation ||
      !options.templates.payment_received ||
      !options.templates.shipping_update
    ) {
      throw new Error(
        "WhatsappBusinessChannel: `templates` must define order_confirmation, payment_received, and shipping_update.",
      );
    }
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.templates = options.templates;
    this.defaultLocale = options.language ?? "id";
    this.fetchImpl = options.fetch ?? fetch;
    this.graphBaseUrl = (options.graphBaseUrl ?? DEFAULT_GRAPH_BASE).replace(
      /\/+$/,
      "",
    );
  }

  async send(input: NotificationChannelSendInput): Promise<void> {
    const templateName = this.resolveTemplate(input.kind);
    const locale = resolveLocale(input.locale ?? this.defaultLocale);
    const recipient = normalizeIndonesianPhone(input.recipient);
    const components = this.buildComponents(input.kind as WhatsappKind, input.payload, locale);

    const body: MessagesRequestBody = {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: locale },
        components,
      },
    };

    const url = `${this.graphBaseUrl}/${encodeURIComponent(this.phoneNumberId)}/messages`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const details = await readErrorBody(response);
      // Compose a one-line summary so pino's `msg` field is greppable;
      // the structured `details` carries the full Meta error envelope.
      const summary = summariseError(details) ?? response.statusText;
      this.log.error(
        {
          status: response.status,
          kind: input.kind,
          template: templateName,
          recipient,
          details,
        },
        "[plugin-whatsapp] WhatsApp Cloud API rejected the message",
      );
      throw new ChannelDispatchError(
        `WhatsApp Cloud API ${response.status}: ${summary}`,
        response.status,
        details,
      );
    }

    this.log.info(
      {
        kind: input.kind,
        template: templateName,
        recipient,
      },
      "[plugin-whatsapp] template message dispatched",
    );
  }

  /**
   * Resolve the operator-configured template name. `UnsupportedKindError`
   * here means the operator booted the plugin without configuring a
   * template for this kind — distinct from "the template name was
   * configured but Meta has not approved it yet" (that surfaces as a
   * `ChannelDispatchError` with `code: 132001`).
   */
  private resolveTemplate(kind: string): string {
    if (kind === "order_confirmation" || kind === "payment_received" || kind === "shipping_update") {
      const name = this.templates[kind];
      if (!name) throw new UnsupportedKindError(kind);
      return name;
    }
    throw new UnsupportedKindError(kind);
  }

  /**
   * Map the structured payload to WhatsApp components. The cast to the
   * kind-specific payload type is safe because the service hands us the
   * payload that matches the kind (the discriminated union is enforced
   * one layer up in `NotificationServiceImpl.send`).
   */
  private buildComponents(
    kind: WhatsappKind,
    payload: Record<string, unknown> | undefined,
    locale: WhatsappLocale,
  ): WhatsappTemplateComponent[] {
    if (!payload) {
      throw new Error(
        `WhatsApp channel: missing structured payload for kind "${kind}".`,
      );
    }
    switch (kind) {
      case "order_confirmation":
        return buildOrderConfirmationComponents(
          payload as unknown as OrderConfirmationPayload,
          locale,
        );
      case "payment_received":
        return buildPaymentReceivedComponents(
          payload as unknown as PaymentReceivedPayload,
          locale,
        );
      case "shipping_update":
        return buildShippingUpdateComponents(
          payload as unknown as ShippingUpdatePayload,
          locale,
        );
    }
  }
}

/**
 * Best-effort parse of the upstream error body. Meta normally returns
 * JSON; the edge layer occasionally returns HTML on 5xx. We hand the raw
 * text back when JSON parsing fails so the operator can see the actual
 * payload in logs.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Pull a human-readable summary out of a Meta error envelope. The shape
 * Meta documents is `{ error: { message, code, type, error_subcode } }`;
 * unknown shapes fall through to the caller's HTTP statusText.
 */
function summariseError(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const root = details as { error?: unknown };
  const err = root.error;
  if (!err || typeof err !== "object") return undefined;
  const e = err as { message?: unknown; code?: unknown };
  const message = typeof e.message === "string" ? e.message : undefined;
  const code = typeof e.code === "number" ? `code=${e.code}` : undefined;
  if (message && code) return `${message} (${code})`;
  return message ?? code;
}

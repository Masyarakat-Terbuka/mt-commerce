/**
 * `@mt-commerce/plugin-notification-whatsapp` — real WhatsApp delivery
 * for mt-commerce.
 *
 * Replaces the v0.1 in-tree `WhatsappStubChannel` (which throws on every
 * send) with a Meta WhatsApp Cloud API adapter. Once the operator wires
 * this plugin in `mt-commerce.config.ts`, the notification service's
 * order-placed / payment-captured / fulfillment-shipped listeners route
 * customer-facing pings through `whatsapp` for any order whose customer
 * (or shipping address) carries a phone number.
 *
 * What plugin authors should know:
 *
 *   - The factory pattern (operator passes options at config time) keeps
 *     the secrets (`accessToken`) outside the manifest. The factory
 *     validates options eagerly so a misconfigured deploy fails at boot
 *     rather than at first send.
 *
 *   - The channel registers under the built-in `"whatsapp"` id. The
 *     notification service's `registerChannel` rejects duplicate ids; the
 *     stub is registered in the BUILT-IN registry while plugins go into a
 *     SEPARATE plugin sub-registry consulted on miss, so the stub does
 *     not block this plugin from loading. The plugin sub-registry takes
 *     precedence at lookup, which is what makes "plugin replaces stub"
 *     true at runtime.
 *
 *   - The plugin makes no event subscriptions of its own — the
 *     notification service drives dispatch. A future operator-controlled
 *     "send a custom WA broadcast" admin endpoint would still go through
 *     the service, not the channel directly.
 */
import {
  definePlugin,
  type Plugin,
} from "@mt-commerce/core/plugin";
import {
  WhatsappBusinessChannel,
  type WhatsappBusinessChannelOptions,
  type WhatsappTemplateMap,
} from "./channel.js";
import type { WhatsappLocale } from "./locale.js";

export interface WhatsappOptions {
  /** Phone number id from the Meta WhatsApp Business dashboard. */
  phoneNumberId: string;
  /** Permanent access token for the WhatsApp Business API. */
  accessToken: string;
  /**
   * Approved template names per kind. v0.1 needs these three; adding
   * more kinds means adding both a Meta-approved template and a mapper
   * in `src/templates.ts`.
   */
  templates: WhatsappTemplateMap;
  /** Default Meta `language.code`. Defaults `"id"`. */
  language?: WhatsappLocale;
  /** Test seam: override `fetch`. Production never sets this. */
  fetch?: typeof fetch;
  /** Test seam: override the Graph API base URL. Production never sets this. */
  graphBaseUrl?: string;
}

export function whatsappPlugin(options: WhatsappOptions): Plugin {
  const channelOptions: WhatsappBusinessChannelOptions = {
    phoneNumberId: options.phoneNumberId,
    accessToken: options.accessToken,
    templates: options.templates,
    ...(options.language ? { language: options.language } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.graphBaseUrl ? { graphBaseUrl: options.graphBaseUrl } : {}),
  };
  return definePlugin({
    name: "@mt-commerce/plugin-notification-whatsapp",
    version: "0.1.0",
    setup(ctx) {
      ctx.registerNotificationChannel(
        new WhatsappBusinessChannel(channelOptions, ctx.log),
      );
      ctx.log.info(
        {
          phoneNumberId: options.phoneNumberId,
          language: channelOptions.language ?? "id",
          templates: Object.keys(options.templates),
        },
        "[plugin-whatsapp] channel registered",
      );
    },
  });
}

// Default export so `import whatsappPlugin from "..."` works alongside
// the named export. The example plugin establishes the same convention.
export default whatsappPlugin;

// Re-exports for advanced wiring (e.g. operators who want to construct
// the channel themselves for non-config-file scenarios).
export { WhatsappBusinessChannel } from "./channel.js";
export { ChannelDispatchError, UnsupportedKindError } from "./errors.js";
export { normalizeIndonesianPhone, toE164 } from "./phone.js";
export type { WhatsappLocale } from "./locale.js";
export type {
  WhatsappBusinessChannelOptions,
  WhatsappKind,
  WhatsappTemplateMap,
} from "./channel.js";

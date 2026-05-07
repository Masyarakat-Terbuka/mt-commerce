/**
 * `WhatsappStubChannel` — placeholder for the future WhatsApp plugin.
 *
 * Per the v0.1 checklist, real WhatsApp delivery is a separate plugin
 * (`packages/plugins/notification-whatsapp`) that lands later. The stub
 * exists so:
 *
 *   1. The notification module's channel registry has an entry for
 *      `whatsapp` from day one — service-level dispatch resolves it
 *      without a special-case branch.
 *
 *   2. Cross-module callers who hard-code `channel: 'whatsapp'` for an
 *      order-confirmation event do not crash; the audit row is written
 *      with `status='pending'` and a clear `error_message` explaining
 *      the channel is not yet wired.
 *
 * The stub deliberately throws, which is what triggers the service to
 * mark the row as `failed` with `error_message` set. Throwing rather
 * than returning silently is the right behavior: a no-op success would
 * lie to the caller and let "did the customer get the message?"
 * audit queries return false positives.
 */
import { childLogger } from "../../../lib/logger.js";
import type { ChannelSendInput, NotificationChannel } from "./types.js";

const log = childLogger("notification:whatsapp");

export class WhatsappStubChannel implements NotificationChannel {
  readonly id = "whatsapp" as const;

  async send(input: ChannelSendInput): Promise<void> {
    log.warn(
      {
        kind: input.kind,
        recipient: input.recipient,
      },
      "[notification:whatsapp] stub channel — install the WhatsApp plugin to deliver",
    );
    throw new Error(
      "WhatsApp channel is a stub in v0.1; install the WhatsApp notification plugin to enable delivery.",
    );
  }
}

/**
 * `ConsoleEmailChannel` — log-only adapter used in development and as the
 * fallback when SMTP is unconfigured outside of production.
 *
 * Why a dedicated channel rather than "the SMTP channel falls back to
 * logging when it cannot connect": the failure modes are different. SMTP
 * unavailability is an operational error that should bubble up; "we picked
 * the console channel on purpose because the operator did not wire SMTP"
 * is a feature, not a degraded state. Splitting the two keeps the
 * production guard (SMTP MUST be configured) honest.
 *
 * The channel logs the full body at info level so a developer running the
 * API in another terminal can see the verification link, order
 * confirmation, etc., without standing up a real mail server.
 *
 * SECURITY: this channel is NOT safe for production. The auth module's
 * `sendVerificationEmail` is the canonical example — logging the
 * verification URL on a production host would dump account-takeover
 * material into operator-readable logs. The notification service refuses
 * to wire the console channel as the default in production via
 * `NOTIFICATION_DEFAULT_CHANNEL` defaulting to `smtp` there.
 */
import type pino from "pino";
import { childLogger } from "../../../lib/logger.js";
import type { ChannelSendInput, NotificationChannel } from "./types.js";

/**
 * Pino-shaped sink. Tests inject a fake to assert the channel logs the
 * expected fields without depending on the global logger's transport.
 */
export interface ConsoleSink {
  info(obj: Record<string, unknown>, msg: string): void;
}

export class ConsoleEmailChannel implements NotificationChannel {
  readonly id = "email" as const;

  private readonly sink: ConsoleSink;

  constructor(sink?: ConsoleSink) {
    this.sink = sink ?? (childLogger("notification:console") as pino.Logger);
  }

  async send(input: ChannelSendInput): Promise<void> {
    // Single info-level log line carrying every field a reviewer or
    // developer needs. We avoid splitting across multiple lines because
    // pino correlates by the single `msg` field; one line per delivery is
    // easier to grep and easier to assert against in tests.
    this.sink.info(
      {
        kind: input.kind,
        recipient: input.recipient,
        ...(input.subject ? { subject: input.subject } : {}),
        body: input.body,
        ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
      },
      "[notification:console] email delivered (logged, not sent)",
    );
  }
}

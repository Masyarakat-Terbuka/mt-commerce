/**
 * `SmtpEmailChannel` — production email adapter backed by nodemailer.
 *
 * Construction-time guards (the "fail fast" promise the v0.1 checklist
 * makes about real notification adapters):
 *
 *   - In **production** with `SMTP_HOST` unset, the constructor throws.
 *     The API will not start. The alternative — silently degrading to
 *     logging or to nothing — would let real verification emails vanish
 *     after a deploy that forgot the SMTP config.
 *
 *   - In **non-production** with `SMTP_HOST` unset, the constructor
 *     returns a `ConsoleEmailChannel` impostor. This keeps `bun run dev`
 *     working out of the box for a developer who hasn't wired Mailpit
 *     yet, without the SMTP code path executing.
 *
 *   - Once `SMTP_HOST` is set, we build a real nodemailer transporter.
 *     `verify()` is NOT called at construction time on purpose: a
 *     transient network hiccup at boot would prevent the API from
 *     starting. Instead the first send surfaces the connection error
 *     through the audit log's `failed` status.
 *
 * Auth: when `SMTP_USER` / `SMTP_PASS` are absent, the transporter is
 * built without an `auth` object — relays that accept anonymous
 * submission from a trusted host (e.g. an internal Postfix on
 * `localhost`) work as-is.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../../lib/env.js";
import { childLogger } from "../../../lib/logger.js";
import { ConsoleEmailChannel } from "./console.js";
import type { ChannelSendInput, NotificationChannel } from "./types.js";

const log = childLogger("notification:smtp");

export interface SmtpEmailChannelOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  /**
   * Override hook for tests. When provided, the channel uses this instead
   * of constructing a real `nodemailer.createTransport(...)`. Production
   * code never sets this.
   */
  transporter?: Transporter;
}

/**
 * Construct an email channel suitable for the current environment. The
 * factory is the only public entry point; tests that want to inject a
 * fake transporter call `new SmtpEmailChannel(...)` directly.
 *
 * The factory takes a snapshot of `env` at call time rather than reading
 * it lazily — a single notification module is constructed once at boot
 * and the channel selection is a deploy-time concern.
 */
export function createEmailChannel(): NotificationChannel {
  if (!env.smtpHost) {
    if (env.isProd) {
      throw new Error(
        "SMTP_HOST is required when NODE_ENV=production. " +
          "Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM, or run a " +
          "non-production environment to use the console channel.",
      );
    }
    // Non-prod fallback: log instead of attempting SMTP.
    log.warn(
      "SMTP_HOST not set; falling back to ConsoleEmailChannel (non-production).",
    );
    return new ConsoleEmailChannel();
  }
  return new SmtpEmailChannel({
    host: env.smtpHost,
    port: env.smtpPort,
    ...(env.smtpUser ? { user: env.smtpUser } : {}),
    ...(env.smtpPass ? { pass: env.smtpPass } : {}),
    from: env.smtpFrom,
  });
}

export class SmtpEmailChannel implements NotificationChannel {
  readonly id = "email" as const;

  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: SmtpEmailChannelOptions) {
    this.from = options.from;
    if (options.transporter) {
      // Test seam — accept a pre-built mock so tests do not need to mock
      // the entire `nodemailer.createTransport` factory.
      this.transporter = options.transporter;
      return;
    }
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // `secure: true` only at port 465 (implicit TLS). Every other port
      // upgrades via STARTTLS, which is what nodemailer does by default
      // when `secure` is false.
      secure: options.port === 465,
      ...(options.user && options.pass
        ? { auth: { user: options.user, pass: options.pass } }
        : {}),
    });
  }

  async send(input: ChannelSendInput): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: input.recipient,
      ...(input.subject ? { subject: input.subject } : {}),
      text: input.body,
      ...(input.htmlBody ? { html: input.htmlBody } : {}),
    });
  }
}

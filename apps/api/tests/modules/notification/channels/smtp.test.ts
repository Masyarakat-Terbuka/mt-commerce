/**
 * SMTP email channel — verifies the construction-time guard (production
 * without SMTP_HOST throws) and the send path (uses the injected
 * transporter, sets `from`/`to`/`subject`/`text`/`html` correctly).
 *
 * `nodemailer` is module-mocked so tests do not open a real socket.
 * The factory path that builds a real transporter is exercised through
 * the mock; the test seam (`SmtpEmailChannelOptions.transporter`) lets
 * us assert the send behavior without going through the factory at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transporter } from "nodemailer";
import {
  SmtpEmailChannel,
  createEmailChannel,
} from "../../../../src/modules/notification/channels/smtp.js";

vi.mock("nodemailer", () => {
  // Module mock so calls to `nodemailer.createTransport(...)` inside
  // `createEmailChannel(...)` do not actually open a transport.
  const sendMail = vi.fn(async () => ({ messageId: "test" }));
  return {
    default: {
      createTransport: vi.fn(() => ({ sendMail })),
    },
    createTransport: vi.fn(() => ({ sendMail })),
  };
});

describe("SmtpEmailChannel.send", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("calls sendMail with the right envelope", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "ok" }));
    const transporter = { sendMail } as unknown as Transporter;
    const channel = new SmtpEmailChannel({
      host: "smtp.example.com",
      port: 587,
      from: "noreply@shop.example.com",
      transporter,
    });

    await channel.send({
      recipient: "buyer@example.com",
      kind: "order_confirmation",
      subject: "Pesanan Anda telah diterima — #ORD-123",
      body: "Terima kasih.",
      htmlBody: "<p>Terima kasih.</p>",
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: "noreply@shop.example.com",
      to: "buyer@example.com",
      subject: "Pesanan Anda telah diterima — #ORD-123",
      text: "Terima kasih.",
      html: "<p>Terima kasih.</p>",
    });
  });

  it("identifies as the email channel", () => {
    const transporter = { sendMail: vi.fn() } as unknown as Transporter;
    const channel = new SmtpEmailChannel({
      host: "smtp.example.com",
      port: 587,
      from: "x@example.com",
      transporter,
    });
    expect(channel.id).toBe("email");
  });
});

describe("createEmailChannel — environment guards", () => {
  /**
   * The env helper is constructed once at import; we re-import the
   * notification module so each test that mutates env sees a fresh
   * `env` snapshot. Vitest's `vi.resetModules()` reloads on demand.
   */
  async function importWith(envOverrides: Record<string, string>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(envOverrides)) {
      vi.stubEnv(key, value);
    }
    return import("../../../../src/modules/notification/channels/smtp.js");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to the console channel in non-production when SMTP_HOST is unset", async () => {
    // `vi.stubEnv` only adds; we want to *not* set SMTP_HOST. Since the
    // outer test config also leaves it unset, the env loader picks up
    // `undefined` and the schema's `.optional()` accepts that.
    vi.resetModules();
    const mod = await import("../../../../src/modules/notification/channels/smtp.js");
    const channel = mod.createEmailChannel();
    expect(channel.id).toBe("email");
    // Console fallback is identified by its constructor name; structural
    // equality would couple the test to internals.
    expect(channel.constructor.name).toBe("ConsoleEmailChannel");
  });

  it("throws in production when SMTP_HOST is unset", async () => {
    const mod = await importWith({
      NODE_ENV: "production",
      // production requires these to load env at all
      DATABASE_URL: "postgres://x:y@z/db",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-test",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(() => mod.createEmailChannel()).toThrow(/SMTP_HOST is required/);
  });
});

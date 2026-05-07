/**
 * Console email channel — verifies the channel logs at info level with the
 * right structured fields. We inject a fake `ConsoleSink` rather than spy
 * on the global pino instance because pino's child loggers are independent
 * objects that the global mocks would not capture.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ConsoleEmailChannel,
  type ConsoleSink,
} from "../../../../src/modules/notification/channels/console.js";

function createSink(): ConsoleSink & { calls: Array<[Record<string, unknown>, string]> } {
  const calls: Array<[Record<string, unknown>, string]> = [];
  return {
    info: vi.fn((obj: Record<string, unknown>, msg: string) => {
      calls.push([obj, msg]);
    }),
    calls,
  };
}

describe("ConsoleEmailChannel", () => {
  it("logs at info level with kind, recipient, subject, body, and htmlBody", async () => {
    const sink = createSink();
    const channel = new ConsoleEmailChannel(sink);

    await channel.send({
      recipient: "buyer@example.com",
      kind: "email_verification",
      subject: "Konfirmasi alamat email Anda",
      body: "Halo, silakan konfirmasi.",
      htmlBody: "<p>Halo</p>",
    });

    expect(sink.calls).toHaveLength(1);
    const [obj, msg] = sink.calls[0]!;
    expect(obj).toEqual({
      kind: "email_verification",
      recipient: "buyer@example.com",
      subject: "Konfirmasi alamat email Anda",
      body: "Halo, silakan konfirmasi.",
      htmlBody: "<p>Halo</p>",
    });
    expect(msg).toContain("notification:console");
  });

  it("omits subject and htmlBody when not provided", async () => {
    const sink = createSink();
    const channel = new ConsoleEmailChannel(sink);

    await channel.send({
      recipient: "buyer@example.com",
      kind: "shipping_update",
      body: "Pesanan Anda dikirim.",
    });

    const [obj] = sink.calls[0]!;
    expect(obj).toEqual({
      kind: "shipping_update",
      recipient: "buyer@example.com",
      body: "Pesanan Anda dikirim.",
    });
  });

  it("identifies as the email channel", () => {
    const channel = new ConsoleEmailChannel();
    expect(channel.id).toBe("email");
  });
});

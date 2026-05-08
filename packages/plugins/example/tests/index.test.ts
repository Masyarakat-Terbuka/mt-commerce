import { describe, expect, it, vi } from "vitest";
import type {
  DomainEventName,
  DomainEventPayload,
  NotificationChannel,
  PluginContext,
  PluginLogger,
} from "@mt-commerce/core/plugin";
import examplePlugin from "../src/index.js";

function makeContext(): {
  ctx: PluginContext;
  log: ReturnType<typeof makeLogger>["log"];
  registered: { channels: NotificationChannel[] };
  listeners: Map<string, ((payload: unknown) => void)[]>;
} {
  const channels: NotificationChannel[] = [];
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const { log, calls } = makeLogger();
  void calls;

  const ctx: PluginContext = {
    log,
    config: {},
    registerPaymentProvider: vi.fn(),
    registerShippingProvider: vi.fn(),
    registerNotificationChannel: (channel) => {
      channels.push(channel);
    },
    on<E extends DomainEventName>(
      event: E,
      listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
    ) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener as (payload: unknown) => void);
      listeners.set(event, bucket);
      return () => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== listener),
        );
      };
    },
  };
  return { ctx, log, registered: { channels }, listeners };
}

function makeLogger(): { log: PluginLogger; calls: Record<string, unknown[][]> } {
  const calls = { info: [] as unknown[][], debug: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  const make = (level: keyof typeof calls) =>
    (...args: unknown[]) => {
      calls[level].push(args);
    };
  return {
    log: {
      info: make("info"),
      debug: make("debug"),
      warn: make("warn"),
      error: make("error"),
    } as unknown as PluginLogger,
    calls,
  };
}

describe("examplePlugin", () => {
  it("declares the manifest fields the loader requires", () => {
    const plugin = examplePlugin();
    expect(plugin.name).toBe("@mt-commerce/plugin-example");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers the example notification channel and an order.placed listener", async () => {
    const plugin = examplePlugin();
    const { ctx, registered, listeners } = makeContext();
    await plugin.setup(ctx);

    expect(registered.channels).toHaveLength(1);
    expect(registered.channels[0]?.id).toBe("example");
    expect(listeners.get("order.placed")).toHaveLength(1);
  });

  it("the registered channel resolves its send promise without throwing", async () => {
    const plugin = examplePlugin();
    const { ctx, registered } = makeContext();
    await plugin.setup(ctx);
    const [channel] = registered.channels;
    expect(channel).toBeDefined();
    await expect(
      channel!.send({
        recipient: "buyer@example.com",
        kind: "order_confirmation",
        subject: "Pesanan diterima",
        body: "Terima kasih telah berbelanja.",
      }),
    ).resolves.toBeUndefined();
  });
});

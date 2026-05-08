import { describe, expect, it, vi } from "vitest";
import biteshipPlugin from "../src/index.js";
import { BiteshipShippingProvider } from "../src/provider.js";
import type {
  DomainEventName,
  DomainEventPayload,
  PluginContext,
  PluginLogger,
  ShippingMethodLike,
  ShippingProvider,
} from "@mt-commerce/core/plugin";

function fakeFetch(payload: unknown, status = 200) {
  return vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
}

function makeContext(): {
  ctx: PluginContext;
  registered: ShippingProvider[];
} {
  const registered: ShippingProvider[] = [];
  const log: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const ctx: PluginContext = {
    log,
    config: {},
    registerPaymentProvider: vi.fn(),
    registerShippingProvider: (p) => {
      registered.push(p);
    },
    registerNotificationChannel: vi.fn(),
    on: <E extends DomainEventName>(
      _event: E,
      _listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
    ) => () => {},
  };
  return { ctx, registered };
}

const seedMethod: ShippingMethodLike = {
  code: "JNE_REG",
  providerKind: "plugin",
  flatRate: null,
};

describe("biteshipPlugin (factory)", () => {
  it("declares the manifest fields the loader requires", () => {
    const plugin = biteshipPlugin({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
    });
    expect(plugin.name).toBe("@mt-commerce/plugin-shipping-biteship");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers a shipping provider with code 'biteship'", async () => {
    const plugin = biteshipPlugin({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
    });
    const { ctx, registered } = makeContext();
    await plugin.setup(ctx);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.code).toBe("biteship");
  });

  it("throws on missing apiKey", () => {
    expect(() =>
      biteshipPlugin({
        // @ts-expect-error — exercising runtime validation
        apiKey: undefined,
        origin: { postalCode: "12345" },
      }),
    ).toThrow(/apiKey/);
  });

  it("throws on missing origin postalCode", () => {
    expect(() =>
      biteshipPlugin({
        apiKey: "test_abc",
        // @ts-expect-error — exercising runtime validation
        origin: {},
      }),
    ).toThrow(/postalCode/);
  });
});

describe("BiteshipShippingProvider.quoteRates — selection", () => {
  it("returns the cheapest rate when the method code is unmapped", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        { courier_code: "jne", courier_service_code: "reg", price: 18_000 },
        { courier_code: "jnt", courier_service_code: "ez", price: 16_000 },
        { courier_code: "sicepat", courier_service_code: "reg", price: 14_000 },
      ],
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.quoteRates(
      { code: "FREE_FOR_ALL", providerKind: "plugin", flatRate: null },
      {
        currency: "IDR",
        destination: { postalCode: "67890" },
        items: [{ name: "x", quantity: 1, value: 50_000, weight: 100 }],
      },
    );
    expect(result.money.amount).toBe(14_000n);
    expect(result.rate.courierCode).toBe("sicepat");
  });

  it("returns the seed-pinned rate when the method code maps to a courier+service", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        { courier_code: "jne", courier_service_code: "oke", price: 12_000 },
        { courier_code: "jne", courier_service_code: "reg", price: 18_000 },
        { courier_code: "jne", courier_service_code: "yes", price: 28_000 },
      ],
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.quoteRates(seedMethod, {
      currency: "IDR",
      destination: { postalCode: "67890" },
      items: [{ name: "x", quantity: 1, value: 50_000, weight: 100 }],
    });
    // JNE_REG seed pins reg, not the cheapest oke.
    expect(result.money.amount).toBe(18_000n);
    expect(result.rate.courierServiceCode).toBe("reg");
  });
});

describe("BiteshipShippingProvider.createOrder — happy path", () => {
  it("returns trackingCode and providerRef from a successful order", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      id: "biteship_o_42",
      courier: { tracking_id: "TRACK-42" },
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: {
        postalCode: "12345",
        contactName: "Toko",
        contactPhone: "+6281000000001",
      },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.createOrder({
      fulfillmentId: "ful_X",
      methodCode: "JNE_REG",
      destination: {
        postalCode: "67890",
        contactName: "Budi",
        contactPhone: "+62812",
      },
      items: [{ name: "x", quantity: 1, value: 50_000, weight: 100 }],
    });
    expect(result.trackingCode).toBe("TRACK-42");
    expect(result.providerRef).toBe("biteship_o_42");
  });
});

describe("BiteshipShippingProvider.quote — context bridge", () => {
  it("throws when no defaultContextProvider is wired", async () => {
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fakeFetch({}) as unknown as typeof fetch,
    });
    await expect(provider.quote(seedMethod, { currency: "IDR" })).rejects.toThrow(
      /context/i,
    );
  });

  it("uses defaultContextProvider when supplied", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        { courier_code: "jne", courier_service_code: "reg", price: 21_000 },
      ],
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fetchSpy as unknown as typeof fetch,
      defaultContextProvider: () => ({
        destination: { postalCode: "67890" },
        items: [{ name: "x", quantity: 1, value: 50_000, weight: 100 }],
      }),
    });
    const money = await provider.quote(seedMethod, { currency: "IDR" });
    expect(money.amount).toBe(21_000n);
    expect(money.currency).toBe("IDR");
  });
});

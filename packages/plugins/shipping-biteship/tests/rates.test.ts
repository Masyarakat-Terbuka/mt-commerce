import { describe, expect, it, vi } from "vitest";
import { BiteshipShippingProvider } from "../src/provider.js";
import type { ShippingMethodLike } from "@mt-commerce/core/plugin";

function fakeFetch(payload: unknown, status = 200) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    void init;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
}

const seedMethod: ShippingMethodLike = {
  code: "JNE_REG",
  providerKind: "plugin",
  flatRate: null,
};

const unmappedMethod: ShippingMethodLike = {
  code: "UNKNOWN_CODE",
  providerKind: "plugin",
  flatRate: null,
};

const sampleItems = [
  { name: "Kaos", quantity: 1, value: 100_000, weight: 250 },
];

describe("BiteshipShippingProvider.quoteRates — request shape", () => {
  it("posts to /v1/rates/couriers with origin, destination, items, and the seed's courier", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        {
          courier_code: "jne",
          courier_name: "JNE",
          courier_service_code: "reg",
          courier_service_name: "JNE Reguler",
          price: 18_000,
          duration: "2-3 hari",
          available_for_cash_on_delivery: true,
          service_type: "standard",
        },
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
      items: sampleItems,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.biteship.com/v1/rates/couriers");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      origin_postal_code: "12345",
      destination_postal_code: "67890",
      couriers: "jne",
      items: [
        { name: "Kaos", quantity: 1, value: 100_000, weight: 250 },
      ],
    });
    expect(result.money.amount).toBe(18_000n);
    expect(result.money.currency).toBe("IDR");
  });

  it("uses the configured courier list when the method code is not seeded", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        {
          courier_code: "jnt",
          courier_service_code: "ez",
          price: 15_000,
        },
        {
          courier_code: "sicepat",
          courier_service_code: "reg",
          price: 12_000,
        },
      ],
    });

    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      couriers: ["jnt", "sicepat"],
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const result = await provider.quoteRates(unmappedMethod, {
      currency: "IDR",
      destination: { postalCode: "67890" },
      items: sampleItems,
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(body.couriers).toBe("jnt,sicepat");
    // Cheapest wins when no method seed pinpoints a courier+service.
    expect(result.rate.courierCode).toBe("sicepat");
    expect(result.money.amount).toBe(12_000n);
  });

  it("filters to COD-capable rates when cod=true", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        {
          courier_code: "jne",
          courier_service_code: "reg",
          price: 18_000,
          available_for_cash_on_delivery: false,
        },
        {
          courier_code: "jnt",
          courier_service_code: "ez",
          price: 20_000,
          available_for_cash_on_delivery: true,
        },
      ],
    });

    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const result = await provider.quoteRates(unmappedMethod, {
      currency: "IDR",
      destination: { postalCode: "67890" },
      items: sampleItems,
      cod: true,
    });

    expect(result.rates).toHaveLength(1);
    expect(result.rate.courierCode).toBe("jnt");
    expect(result.rate.cod).toBe(true);
  });

  it("forwards origin and destination coordinates when present", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      pricing: [
        {
          courier_code: "gojek",
          courier_service_code: "instant",
          price: 35_000,
        },
      ],
    });

    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345", latitude: -6.2, longitude: 106.8 },
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await provider.quoteRates(
      { code: "GOJEK_INSTANT", providerKind: "plugin", flatRate: null },
      {
        currency: "IDR",
        destination: {
          postalCode: "67890",
          latitude: -6.3,
          longitude: 106.9,
        },
        items: sampleItems,
      },
    );

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(body.origin_latitude).toBe(-6.2);
    expect(body.origin_longitude).toBe(106.8);
    expect(body.destination_latitude).toBe(-6.3);
    expect(body.destination_longitude).toBe(106.9);
  });

  it("rejects non-IDR currency", async () => {
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fakeFetch({}) as unknown as typeof fetch,
    });
    await expect(
      provider.quoteRates(seedMethod, {
        currency: "USD",
        destination: { postalCode: "67890" },
        items: sampleItems,
      }),
    ).rejects.toThrow(/IDR/);
  });
});

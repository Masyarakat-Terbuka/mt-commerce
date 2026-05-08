import { describe, expect, it, vi } from "vitest";
import { BiteshipShippingProvider } from "../src/provider.js";

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

const sampleItems = [
  { name: "Kaos", quantity: 2, value: 100_000, weight: 250 },
];

const sampleDestination = {
  postalCode: "67890",
  contactName: "Budi Santoso",
  contactPhone: "+6281234567890",
  contactEmail: "budi@example.com",
  address: "Jl. Mawar No. 1, Jakarta",
};

describe("BiteshipShippingProvider.createOrder — request shape", () => {
  it("posts to /v1/orders with the courier+service from the seed", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      id: "order_123",
      courier: { tracking_id: "JNE-001", waybill_id: null },
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: {
        postalCode: "12345",
        address: "Gudang Pusat",
        contactName: "Toko ABC",
        contactPhone: "+6281000000001",
      },
      fetch: fetchSpy as unknown as typeof fetch,
    });

    const result = await provider.createOrder({
      fulfillmentId: "ful_01HABC",
      methodCode: "JNE_REG",
      destination: sampleDestination,
      items: sampleItems,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.biteship.com/v1/orders");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      reference_id: "ful_01HABC",
      origin_postal_code: "12345",
      origin_address: "Gudang Pusat",
      destination_contact_name: "Budi Santoso",
      destination_contact_phone: "+6281234567890",
      destination_contact_email: "budi@example.com",
      destination_postal_code: "67890",
      courier_company: "jne",
      courier_type: "reg",
      delivery_type: "now",
      items: [
        { name: "Kaos", quantity: 2, value: 100_000, weight: 250 },
      ],
    });
    expect(result.trackingCode).toBe("JNE-001");
    expect(result.providerRef).toBe("order_123");
  });

  it("requires destination contactName + contactPhone", async () => {
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fakeFetch({}) as unknown as typeof fetch,
    });
    await expect(
      provider.createOrder({
        fulfillmentId: "ful_x",
        methodCode: "JNE_REG",
        destination: { postalCode: "67890" },
        items: sampleItems,
      }),
    ).rejects.toThrow(/contactName/);
  });

  it("rejects an unknown method code", async () => {
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: { postalCode: "12345" },
      fetch: fakeFetch({}) as unknown as typeof fetch,
    });
    await expect(
      provider.createOrder({
        fulfillmentId: "ful_x",
        methodCode: "UNMAPPED",
        destination: sampleDestination,
        items: sampleItems,
      }),
    ).rejects.toThrow(/unknown method code/);
  });

  it("forwards COD with a positive amount and rejects missing amount", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      id: "order_cod",
      courier: { tracking_id: "JNT-COD-1" },
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

    await provider.createOrder({
      fulfillmentId: "ful_cod",
      methodCode: "JNT_EZ",
      destination: sampleDestination,
      items: sampleItems,
      cod: true,
      codAmount: 250_000,
    });
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    expect(body.cod).toEqual({ amount: 250_000 });

    await expect(
      provider.createOrder({
        fulfillmentId: "ful_cod_bad",
        methodCode: "JNT_EZ",
        destination: sampleDestination,
        items: sampleItems,
        cod: true,
      }),
    ).rejects.toThrow(/codAmount/);
  });

  it("falls back to waybill_id when tracking_id is null", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      id: "order_456",
      courier: { tracking_id: null, waybill_id: "WAYBILL-789" },
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: {
        postalCode: "12345",
        contactName: "Toko",
        contactPhone: "+62810",
      },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.createOrder({
      fulfillmentId: "ful_y",
      methodCode: "JNE_REG",
      destination: sampleDestination,
      items: sampleItems,
    });
    expect(result.trackingCode).toBe("WAYBILL-789");
  });

  it("returns null tracking when both ids are absent", async () => {
    const fetchSpy = fakeFetch({
      success: true,
      id: "order_pending",
      courier: {},
    });
    const provider = new BiteshipShippingProvider({
      apiKey: "test_abc",
      origin: {
        postalCode: "12345",
        contactName: "Toko",
        contactPhone: "+62810",
      },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.createOrder({
      fulfillmentId: "ful_z",
      methodCode: "JNE_REG",
      destination: sampleDestination,
      items: sampleItems,
    });
    expect(result.trackingCode).toBeNull();
    expect(result.providerRef).toBe("order_pending");
  });
});

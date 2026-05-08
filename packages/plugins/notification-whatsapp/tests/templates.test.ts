import { describe, expect, it } from "vitest";
import {
  buildOrderConfirmationComponents,
  buildPaymentReceivedComponents,
  buildShippingUpdateComponents,
  formatMoney,
  sanitizeParam,
  type OrderConfirmationPayload,
  type PaymentReceivedPayload,
  type ShippingUpdatePayload,
} from "../src/templates.js";

const orderPayload: OrderConfirmationPayload = {
  orderId: "MT-2025-000123",
  items: [
    {
      name: "Kemeja Batik",
      quantity: 2,
      unitPrice: { amount: "250000", currency: "IDR" },
    },
    {
      name: "Sarung",
      quantity: 1,
      unitPrice: { amount: "150000", currency: "IDR" },
    },
  ],
  totals: {
    subtotal: { amount: "650000", currency: "IDR" },
    tax: { amount: "0", currency: "IDR" },
    shipping: { amount: "20000", currency: "IDR" },
    total: { amount: "670000", currency: "IDR" },
  },
};

describe("formatMoney", () => {
  it("formats IDR with the Indonesian dot separator", () => {
    expect(formatMoney({ amount: "1500000", currency: "IDR" }, "id")).toBe(
      "Rp 1.500.000",
    );
  });

  it("formats IDR with the English comma separator", () => {
    expect(formatMoney({ amount: "1500000", currency: "IDR" }, "en")).toBe(
      "IDR 1,500,000",
    );
  });

  it("preserves a negative sign", () => {
    expect(formatMoney({ amount: "-500", currency: "IDR" }, "id")).toBe(
      "-Rp 500",
    );
  });

  it("falls back to the raw currency code for non-IDR currencies", () => {
    expect(formatMoney({ amount: "9900", currency: "USD" }, "en")).toBe(
      "USD 9,900",
    );
  });
});

describe("sanitizeParam", () => {
  it("collapses internal whitespace and trims edges", () => {
    expect(sanitizeParam("  hello\t world\nagain  ")).toBe("hello world again");
  });

  it("coerces empty strings to a dash so Meta does not reject the parameter", () => {
    expect(sanitizeParam("")).toBe("-");
    expect(sanitizeParam("   ")).toBe("-");
  });
});

describe("buildOrderConfirmationComponents", () => {
  it("emits a body component with order id, total, and item count (id)", () => {
    const components = buildOrderConfirmationComponents(orderPayload, "id");
    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "MT-2025-000123" },
          { type: "text", text: "Rp 670.000" },
          { type: "text", text: "3 barang" },
        ],
      },
    ]);
  });

  it("uses english labels when locale is en", () => {
    const components = buildOrderConfirmationComponents(orderPayload, "en");
    expect(components[0]?.parameters[2]?.text).toBe("3 items");
  });

  it("singularises the english item label when there is exactly one item", () => {
    const onePiece: OrderConfirmationPayload = {
      ...orderPayload,
      items: [orderPayload.items[0]!],
    };
    const components = buildOrderConfirmationComponents(onePiece, "en");
    expect(components[0]?.parameters[2]?.text).toBe("2 items");
    const singleQty: OrderConfirmationPayload = {
      ...orderPayload,
      items: [{ ...orderPayload.items[0]!, quantity: 1 }],
    };
    const single = buildOrderConfirmationComponents(singleQty, "en");
    expect(single[0]?.parameters[2]?.text).toBe("1 item");
  });
});

describe("buildPaymentReceivedComponents", () => {
  it("emits a body component with order id, amount, and method label", () => {
    const payload: PaymentReceivedPayload = {
      orderId: "MT-2025-000123",
      amount: { amount: "670000", currency: "IDR" },
      paymentMethod: "manual_transfer",
    };
    const components = buildPaymentReceivedComponents(payload, "id");
    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "MT-2025-000123" },
          { type: "text", text: "Rp 670.000" },
          { type: "text", text: "manual_transfer" },
        ],
      },
    ]);
  });
});

describe("buildShippingUpdateComponents", () => {
  it("localises status and falls back to '-' when no tracking code is set", () => {
    const payload: ShippingUpdatePayload = {
      orderId: "MT-2025-000123",
      trackingCode: null,
      status: "shipped",
    };
    const components = buildShippingUpdateComponents(payload, "id");
    expect(components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "MT-2025-000123" },
          { type: "text", text: "Dikirim" },
          { type: "text", text: "-" },
        ],
      },
    ]);
  });

  it("passes through the tracking code when present and localises status to en", () => {
    const payload: ShippingUpdatePayload = {
      orderId: "MT-2025-000123",
      trackingCode: "JX-998877",
      status: "shipped",
    };
    const components = buildShippingUpdateComponents(payload, "en");
    expect(components[0]?.parameters[1]?.text).toBe("Shipped");
    expect(components[0]?.parameters[2]?.text).toBe("JX-998877");
  });

  it("passes an unknown status through verbatim (forward-compat for delivered etc.)", () => {
    const payload: ShippingUpdatePayload = {
      orderId: "MT-2025-000123",
      trackingCode: "JX-998877",
      status: "out_for_delivery",
    };
    const components = buildShippingUpdateComponents(payload, "id");
    expect(components[0]?.parameters[1]?.text).toBe("out_for_delivery");
  });
});

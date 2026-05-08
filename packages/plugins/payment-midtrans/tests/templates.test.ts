/**
 * Tests for the pure Snap-request builder + status mapper. Pure helpers
 * deserve their own focused test file — the provider tests below cover
 * the integration glue.
 */
import { describe, expect, it } from "vitest";
import {
  buildSnapTransactionRequest,
  DEFAULT_SNAP_ENABLED_PAYMENTS,
  mapMidtransStatus,
} from "../src/templates.js";

describe("buildSnapTransactionRequest", () => {
  it("maps order_id, gross_amount, customer, callbacks, and enabled_payments", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01HZX1",
      amount: { amount: 150_000n, currency: "IDR" },
      customer: {
        name: "Budi Santoso",
        email: "budi@example.id",
        phone: "+628111222333",
      },
      callbacks: {
        finish: "https://shop.example.id/checkout/selesai",
        pending: "https://shop.example.id/checkout/menunggu",
        error: "https://shop.example.id/checkout/gagal",
      },
    });

    expect(request.transaction_details).toEqual({
      order_id: "pay_01HZX1",
      gross_amount: 150_000,
    });
    expect(request.customer_details).toEqual({
      first_name: "Budi",
      last_name: "Santoso",
      email: "budi@example.id",
      phone: "+628111222333",
    });
    expect(request.callbacks).toEqual({
      finish: "https://shop.example.id/checkout/selesai",
      pending: "https://shop.example.id/checkout/menunggu",
      error: "https://shop.example.id/checkout/gagal",
    });
    expect(request.enabled_payments).toEqual(DEFAULT_SNAP_ENABLED_PAYMENTS);
    expect(request.credit_card).toEqual({ secure: true });
  });

  it("treats IDR amount as a whole-rupiah integer (no /100 conversion)", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01",
      amount: { amount: 1_500_000n, currency: "IDR" },
    });
    expect(request.transaction_details.gross_amount).toBe(1_500_000);
  });

  it("converts cents-stored currencies (e.g. USD) to major-unit amount", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01",
      amount: { amount: 12345n, currency: "USD" },
    });
    // 12345 cents → $123.45 → rounded to 123 (Midtrans takes integer)
    expect(request.transaction_details.gross_amount).toBe(123);
  });

  it("respects an operator-supplied enabled_payments override", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01",
      amount: { amount: 50_000n, currency: "IDR" },
      enabledPayments: ["qris", "gopay"],
    });
    expect(request.enabled_payments).toEqual(["qris", "gopay"]);
  });

  it("omits customer_details and callbacks when unset", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01",
      amount: { amount: 50_000n, currency: "IDR" },
    });
    expect(request.customer_details).toBeUndefined();
    expect(request.callbacks).toBeUndefined();
  });

  it("treats a single-name customer as first_name only", () => {
    const request = buildSnapTransactionRequest({
      paymentId: "pay_01",
      amount: { amount: 50_000n, currency: "IDR" },
      customer: { name: "Sari" },
    });
    expect(request.customer_details).toEqual({ first_name: "Sari" });
  });
});

describe("mapMidtransStatus", () => {
  it("maps settlement → captured", () => {
    expect(mapMidtransStatus("settlement")).toBe("captured");
  });

  it("maps capture (with fraud_status accept) → captured", () => {
    expect(mapMidtransStatus("capture", "accept")).toBe("captured");
  });

  it("maps capture without fraud_status → captured (non-card flow)", () => {
    expect(mapMidtransStatus("capture")).toBe("captured");
  });

  it("maps capture with fraud_status challenge → ignore (still under fraud review)", () => {
    expect(mapMidtransStatus("capture", "challenge")).toBe("ignore");
  });

  it("maps capture with fraud_status deny → failed", () => {
    expect(mapMidtransStatus("capture", "deny")).toBe("failed");
  });

  it("maps cancel/expire/deny/failure → failed", () => {
    expect(mapMidtransStatus("cancel")).toBe("failed");
    expect(mapMidtransStatus("expire")).toBe("failed");
    expect(mapMidtransStatus("deny")).toBe("failed");
    expect(mapMidtransStatus("failure")).toBe("failed");
  });

  it("maps refund/partial_refund → refunded", () => {
    expect(mapMidtransStatus("refund")).toBe("refunded");
    expect(mapMidtransStatus("partial_refund")).toBe("refunded");
  });

  it("maps pending/authorize → ignore (no state change)", () => {
    expect(mapMidtransStatus("pending")).toBe("ignore");
    expect(mapMidtransStatus("authorize")).toBe("ignore");
  });

  it("maps unknown statuses → ignore (forward-compat)", () => {
    expect(mapMidtransStatus("some_future_status")).toBe("ignore");
  });
});

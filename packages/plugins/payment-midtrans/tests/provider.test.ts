/**
 * Provider integration tests. Stubs `fetch` to assert the provider
 * routes lifecycle calls into Snap correctly, and exercises webhook
 * verification with a real signature.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  PaymentIntentLike,
  PluginContext,
  PluginLogger,
} from "@mt-commerce/core/plugin";
import midtransPlugin, {
  MIDTRANS_PROVIDER_CODE,
  MidtransPaymentProvider,
} from "../src/index.js";
import type { FetchLike } from "../src/snap.js";

const SERVER_KEY = "SB-Mid-server-TESTSERVERKEYxxxxxxxxxxxxxxxxxx";

function makeIntent(
  overrides: Partial<PaymentIntentLike> = {},
): PaymentIntentLike {
  return {
    id: "pay_01HZX1ABCDEFGHJKMNPQRSTUVW",
    orderId: "ord_01HZX1ABCDEFGHJKMNPQRSTUVW",
    amount: { amount: 150_000n, currency: "IDR" },
    idempotencyKey: "key_test_idempotency",
    metadata: {
      customerName: "Budi Santoso",
      customerEmail: "budi@example.id",
      customerPhone: "+628111222333",
    },
    ...overrides,
  };
}

function fetchReturning(
  status: number,
  body: unknown,
): { fetch: FetchLike; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, body: init?.body ?? "" });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  }) as unknown as FetchLike;
  return { fetch, calls };
}

function makeLogger(): PluginLogger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as PluginLogger;
}

// ---------------------------------------------------------------------------
// Construction + plugin manifest
// ---------------------------------------------------------------------------

describe("midtransPlugin (factory)", () => {
  it("returns a Plugin manifest the loader can register", () => {
    const plugin = midtransPlugin({
      serverKey: SERVER_KEY,
      clientKey: "SB-Mid-client-TESTCLIENT",
    });
    expect(plugin.name).toBe("@mt-commerce/plugin-payment-midtrans");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers a payment provider with code 'midtrans' on setup", async () => {
    const plugin = midtransPlugin({
      serverKey: SERVER_KEY,
      clientKey: "SB-Mid-client-TESTCLIENT",
    });
    const registered: { code: string }[] = [];
    const ctx: PluginContext = {
      log: makeLogger(),
      config: {},
      registerPaymentProvider: (provider) => {
        registered.push({ code: provider.code });
      },
      registerShippingProvider: vi.fn(),
      registerNotificationChannel: vi.fn(),
      on: vi.fn(() => () => undefined),
    };
    await plugin.setup(ctx);
    expect(registered).toEqual([{ code: MIDTRANS_PROVIDER_CODE }]);
  });

  it("rejects construction when serverKey is missing", () => {
    expect(() =>
      midtransPlugin({
        serverKey: "",
        clientKey: "ck",
      }).setup({
        log: makeLogger(),
        config: {},
        registerPaymentProvider: vi.fn(),
        registerShippingProvider: vi.fn(),
        registerNotificationChannel: vi.fn(),
        on: vi.fn(() => () => undefined),
      } as PluginContext),
    ).toThrow(/serverKey/);
  });
});

// ---------------------------------------------------------------------------
// initiate
// ---------------------------------------------------------------------------

describe("MidtransPaymentProvider.initiate", () => {
  it("POSTs to Snap and returns a redirect result", async () => {
    const { fetch, calls } = fetchReturning(201, {
      token: "snap-token-abc",
      redirect_url:
        "https://app.sandbox.midtrans.com/snap/v3/redirection/snap-token-abc",
    });
    const provider = new MidtransPaymentProvider(
      {
        serverKey: SERVER_KEY,
        clientKey: "ck",
        finishUrl: "https://shop.example.id/checkout/selesai",
        fetchImpl: fetch,
      },
      makeLogger(),
    );

    const result = await provider.initiate(makeIntent());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/snap/v1/transactions");
    const body = JSON.parse(calls[0]!.body);
    expect(body.transaction_details).toEqual({
      order_id: "pay_01HZX1ABCDEFGHJKMNPQRSTUVW",
      gross_amount: 150_000,
    });
    expect(body.customer_details).toEqual({
      first_name: "Budi",
      last_name: "Santoso",
      email: "budi@example.id",
      phone: "+628111222333",
    });
    expect(body.callbacks).toEqual({
      finish: "https://shop.example.id/checkout/selesai",
    });
    expect(body.enabled_payments).toEqual(
      expect.arrayContaining(["qris", "gopay", "bca_va", "credit_card"]),
    );
    expect(result.providerTransactionId).toBe("snap-token-abc");
    expect(result.redirectUrl).toContain("midtrans.com");
  });

  it("propagates a Midtrans error (401, bad serverKey)", async () => {
    const { fetch } = fetchReturning(401, {
      status_message: "Access denied due to unauthorized transaction",
    });
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck", fetchImpl: fetch },
      makeLogger(),
    );
    await expect(provider.initiate(makeIntent())).rejects.toThrow(
      /Access denied/,
    );
  });
});

// ---------------------------------------------------------------------------
// capture (no-op for Snap auto-capture)
// ---------------------------------------------------------------------------

describe("MidtransPaymentProvider.capture", () => {
  it("returns a structured no-op without calling Midtrans", async () => {
    const { fetch, calls } = fetchReturning(200, {});
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck", fetchImpl: fetch },
      makeLogger(),
    );
    const result = await provider.capture(makeIntent());
    expect(calls).toHaveLength(0);
    expect(result.amountCaptured).toEqual({ amount: 150_000n, currency: "IDR" });
  });
});

// ---------------------------------------------------------------------------
// refund
// ---------------------------------------------------------------------------

describe("MidtransPaymentProvider.refund", () => {
  it("POSTs to /v2/{paymentId}/refund with refund_key, amount, reason", async () => {
    const { fetch, calls } = fetchReturning(200, {
      status_code: "200",
      status_message: "Success, refund request is created",
      transaction_id: "txn-abc",
      order_id: "pay_01HZX1ABCDEFGHJKMNPQRSTUVW",
      gross_amount: "150000",
      refund_amount: "50000",
      refund_key: "key_test_idempotency",
    });
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck", fetchImpl: fetch },
      makeLogger(),
    );

    const result = await provider.refund(
      makeIntent({
        metadata: {
          customerName: "Budi",
          refundReason: "buyer requested",
        },
      }),
      { amount: 50_000n, currency: "IDR" },
    );

    expect(calls[0]?.url).toBe(
      "https://api.sandbox.midtrans.com/v2/pay_01HZX1ABCDEFGHJKMNPQRSTUVW/refund",
    );
    expect(JSON.parse(calls[0]!.body)).toEqual({
      refund_key: "key_test_idempotency",
      amount: 50_000,
      reason: "buyer requested",
    });
    expect(result.amountRefunded).toEqual({ amount: 50_000n, currency: "IDR" });
    expect(result.providerTransactionId).toBe("txn-abc");
  });

  it("falls back to the full intent amount when amount is omitted", async () => {
    const { fetch, calls } = fetchReturning(200, {
      status_code: "200",
      status_message: "ok",
      transaction_id: "txn",
      order_id: "x",
      gross_amount: "150000",
    });
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck", fetchImpl: fetch },
      makeLogger(),
    );
    await provider.refund(makeIntent());
    expect(JSON.parse(calls[0]!.body)).toEqual({
      refund_key: "key_test_idempotency",
      amount: 150_000,
    });
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe("MidtransPaymentProvider.verifyWebhookSignature", () => {
  function signedNotification(opts: {
    order_id: string;
    status_code: string;
    gross_amount: string;
    transaction_status: string;
    extras?: Record<string, unknown>;
  }): string {
    const signature = createHash("sha512")
      .update(
        `${opts.order_id}${opts.status_code}${opts.gross_amount}${SERVER_KEY}`,
        "utf8",
      )
      .digest("hex");
    return JSON.stringify({
      order_id: opts.order_id,
      status_code: opts.status_code,
      gross_amount: opts.gross_amount,
      transaction_status: opts.transaction_status,
      signature_key: signature,
      ...opts.extras,
    });
  }

  it("returns true for a settlement notification with a valid signature", () => {
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck" },
      makeLogger(),
    );
    const body = signedNotification({
      order_id: "pay_01",
      status_code: "200",
      gross_amount: "50000.00",
      transaction_status: "settlement",
    });
    expect(provider.verifyWebhookSignature({ rawBody: body, headers: {} })).toBe(
      true,
    );
  });

  it("returns true for an expire notification with a valid signature", () => {
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck" },
      makeLogger(),
    );
    const body = signedNotification({
      order_id: "pay_02",
      status_code: "202",
      gross_amount: "75000.00",
      transaction_status: "expire",
    });
    expect(provider.verifyWebhookSignature({ rawBody: body, headers: {} })).toBe(
      true,
    );
  });

  it("returns false when the signature does not match", () => {
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck" },
      makeLogger(),
    );
    const body = JSON.stringify({
      order_id: "pay_01",
      status_code: "200",
      gross_amount: "50000.00",
      transaction_status: "settlement",
      signature_key: "deadbeef".repeat(16), // 128 hex chars but wrong content
    });
    expect(
      provider.verifyWebhookSignature({ rawBody: body, headers: {} }),
    ).toBe(false);
  });

  it("returns false on a malformed body", () => {
    const provider = new MidtransPaymentProvider(
      { serverKey: SERVER_KEY, clientKey: "ck" },
      makeLogger(),
    );
    expect(
      provider.verifyWebhookSignature({ rawBody: "not json", headers: {} }),
    ).toBe(false);
    expect(
      provider.verifyWebhookSignature({ rawBody: "", headers: {} }),
    ).toBe(false);
  });
});

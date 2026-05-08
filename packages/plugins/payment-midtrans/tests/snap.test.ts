/**
 * Snap HTTP-client tests. We stub `fetch` per test so we can assert on
 * the request shape (URL, headers, body) without touching the network.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MidtransApiError,
  SnapClient,
  type FetchLike,
} from "../src/snap.js";

interface CapturedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeFetch(
  response: { status: number; body: string },
  captured: CapturedRequest[],
): FetchLike {
  return vi.fn(async (url, init) => {
    captured.push({
      url,
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
    };
  });
}

describe("SnapClient.createTransaction", () => {
  it("POSTs to the sandbox Snap /transactions endpoint by default", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = makeFetch(
      {
        status: 201,
        body: JSON.stringify({
          token: "snap-token-abc",
          redirect_url: "https://app.sandbox.midtrans.com/snap/v3/redirection/snap-token-abc",
        }),
      },
      captured,
    );
    const client = new SnapClient({
      serverKey: "SB-Mid-server-TESTKEY",
      fetchImpl,
    });
    const result = await client.createTransaction({
      transaction_details: { order_id: "pay_01", gross_amount: 50000 },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://app.sandbox.midtrans.com/snap/v1/transactions",
    );
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers?.["Content-Type"]).toBe("application/json");
    expect(captured[0]?.headers?.["Authorization"]).toMatch(/^Basic /);
    // Verify the Basic auth credential decodes to "<serverKey>:"
    const credential = Buffer.from(
      captured[0]!.headers!["Authorization"]!.replace(/^Basic /, ""),
      "base64",
    ).toString("utf8");
    expect(credential).toBe("SB-Mid-server-TESTKEY:");
    // Body is the request we passed in, JSON-encoded
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      transaction_details: { order_id: "pay_01", gross_amount: 50000 },
    });
    expect(result.token).toBe("snap-token-abc");
    expect(result.redirect_url).toContain("midtrans.com");
  });

  it("uses production endpoints when mode is 'production'", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = makeFetch(
      {
        status: 201,
        body: JSON.stringify({
          token: "tok",
          redirect_url: "https://app.midtrans.com/snap/v3/redirection/tok",
        }),
      },
      captured,
    );
    const client = new SnapClient({
      serverKey: "Mid-server-LIVE",
      mode: "production",
      fetchImpl,
    });
    await client.createTransaction({});
    expect(captured[0]?.url).toBe("https://app.midtrans.com/snap/v1/transactions");
  });

  it("throws MidtransApiError with the parsed body on non-2xx", async () => {
    const fetchImpl = makeFetch(
      {
        status: 401,
        body: JSON.stringify({
          status_message: "Access denied due to unauthorized transaction",
          error_messages: ["Bad server key"],
        }),
      },
      [],
    );
    const client = new SnapClient({
      serverKey: "wrong",
      fetchImpl,
    });
    await expect(client.createTransaction({})).rejects.toMatchObject({
      name: "MidtransApiError",
      status: 401,
      message: "Access denied due to unauthorized transaction",
    });
  });

  it("throws MidtransApiError when the response body is not JSON", async () => {
    const fetchImpl = makeFetch(
      { status: 502, body: "<html>Bad Gateway</html>" },
      [],
    );
    const client = new SnapClient({
      serverKey: "k",
      fetchImpl,
    });
    await expect(client.createTransaction({})).rejects.toBeInstanceOf(
      MidtransApiError,
    );
  });

  it("throws MidtransApiError when the body is missing token/redirect_url", async () => {
    const fetchImpl = makeFetch(
      {
        status: 201,
        body: JSON.stringify({ unexpected: true }),
      },
      [],
    );
    const client = new SnapClient({ serverKey: "k", fetchImpl });
    await expect(client.createTransaction({})).rejects.toBeInstanceOf(
      MidtransApiError,
    );
  });
});

describe("SnapClient.refund", () => {
  it("POSTs to the Core API /v2/{orderId}/refund endpoint", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = makeFetch(
      {
        status: 200,
        body: JSON.stringify({
          status_code: "200",
          status_message: "ok",
          transaction_id: "txn-123",
          order_id: "pay_01",
          gross_amount: "50000",
          refund_amount: "50000",
          refund_key: "rfd_01",
        }),
      },
      captured,
    );
    const client = new SnapClient({
      serverKey: "SB-Mid-server-TESTKEY",
      fetchImpl,
    });
    const result = await client.refund({
      orderId: "pay_01",
      refundKey: "rfd_01",
      amount: 50000,
      reason: "buyer requested",
    });
    expect(captured[0]?.url).toBe(
      "https://api.sandbox.midtrans.com/v2/pay_01/refund",
    );
    expect(JSON.parse(captured[0]!.body!)).toEqual({
      refund_key: "rfd_01",
      amount: 50000,
      reason: "buyer requested",
    });
    expect(result.transaction_id).toBe("txn-123");
  });

  it("URL-encodes the orderId path segment", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = makeFetch(
      { status: 200, body: JSON.stringify({ status_code: "200", status_message: "ok", transaction_id: "x", order_id: "y", gross_amount: "1" }) },
      captured,
    );
    const client = new SnapClient({ serverKey: "k", fetchImpl });
    await client.refund({ orderId: "pay/with slash", refundKey: "rfd_01" });
    expect(captured[0]?.url).toContain("pay%2Fwith%20slash");
  });

  it("omits amount and reason when not supplied (full refund without explanation)", async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = makeFetch(
      { status: 200, body: JSON.stringify({ status_code: "200", status_message: "ok", transaction_id: "x", order_id: "y", gross_amount: "1" }) },
      captured,
    );
    const client = new SnapClient({ serverKey: "k", fetchImpl });
    await client.refund({ orderId: "pay_01", refundKey: "rfd_01" });
    expect(JSON.parse(captured[0]!.body!)).toEqual({ refund_key: "rfd_01" });
  });
});

describe("SnapClient construction", () => {
  it("rejects an empty serverKey", () => {
    expect(() => new SnapClient({ serverKey: "" })).toThrow(/serverKey/);
  });
  it("rejects a whitespace-only serverKey", () => {
    expect(() => new SnapClient({ serverKey: "   " })).toThrow(/serverKey/);
  });
});

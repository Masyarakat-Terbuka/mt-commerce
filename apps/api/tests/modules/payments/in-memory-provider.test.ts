/**
 * `InMemoryTestPaymentProvider` — unit tests over the test double.
 *
 * The provider is the canonical test double; integration tests rely on
 * its behaviour (signature scheme, `TEST_PENDING_*` / `TEST_FAIL`
 * codes). A regression here would silently break every integration
 * spec that depends on it, so we pin the contract directly.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryTestPaymentProvider,
  signTestWebhook,
} from "../../../src/modules/payments/providers/in-memory.js";

function defaultInitiateInput() {
  return {
    payment: {
      id: "pay_1",
      orderId: "ord_1",
      amount: 100_000n,
      currency: "IDR",
    },
    customer: {
      id: "cust_1",
      email: "buyer@example.com",
      phone: null,
      name: null,
    },
  };
}

describe("InMemoryTestPaymentProvider — initiate", () => {
  it("default: returns captured + tracks state", async () => {
    const provider = createInMemoryTestPaymentProvider();
    const result = await provider.initiate(defaultInitiateInput());
    expect(result.status).toBe("captured");
    if (result.status === "captured") {
      expect(result.providerRef).toMatch(/^test_/);
    }
    expect(provider.inspect("pay_1")?.status).toBe("captured");
  });

  it("metadata.code starting with TEST_PENDING_ returns pending", async () => {
    const provider = createInMemoryTestPaymentProvider();
    const result = await provider.initiate({
      ...defaultInitiateInput(),
      metadata: { code: "TEST_PENDING_offline_transfer" },
    });
    expect(result.status).toBe("pending");
    expect(provider.inspect("pay_1")?.status).toBe("pending");
  });

  it("metadata.code starting with TEST_REDIRECT_ returns redirect with URL", async () => {
    const provider = createInMemoryTestPaymentProvider();
    const result = await provider.initiate({
      ...defaultInitiateInput(),
      metadata: { code: "TEST_REDIRECT_snap" },
    });
    expect(result.status).toBe("redirect");
    if (result.status === "redirect") {
      expect(result.redirectUrl).toMatch(/^https:\/\/example\.test\/pay\//);
    }
  });

  it("metadata.code TEST_FAIL throws a simulated upstream failure", async () => {
    const provider = createInMemoryTestPaymentProvider();
    await expect(
      provider.initiate({
        ...defaultInitiateInput(),
        metadata: { code: "TEST_FAIL" },
      }),
    ).rejects.toThrow(/simulated failure/);
  });
});

describe("InMemoryTestPaymentProvider — verifyWebhookSignature", () => {
  it("accepts a body signed with the configured secret and projects to canonical shape", () => {
    const provider = createInMemoryTestPaymentProvider({ secret: "s3cret" });
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: "test_abc",
      status: "captured",
      raw: { foo: "bar" },
    });
    const signature = signTestWebhook("s3cret", body);
    const verified = provider.verifyWebhookSignature({
      rawBody: body,
      headers: { "x-mt-test-signature": signature },
    });
    expect(verified.event).toBe("payment.captured");
    expect(verified.providerRef).toBe("test_abc");
    expect(verified.status).toBe("captured");
    expect(verified.rawPayload.raw).toEqual({ foo: "bar" });
  });

  it("rejects a body whose signature does not match", () => {
    const provider = createInMemoryTestPaymentProvider({ secret: "s3cret" });
    const body = JSON.stringify({
      event: "payment.captured",
      providerRef: "test_abc",
      status: "captured",
    });
    const wrongSignature = signTestWebhook("different", body);
    expect(() =>
      provider.verifyWebhookSignature({
        rawBody: body,
        headers: { "x-mt-test-signature": wrongSignature },
      }),
    ).toThrow(/signature mismatch/);
  });

  it("rejects a missing signature header", () => {
    const provider = createInMemoryTestPaymentProvider();
    expect(() =>
      provider.verifyWebhookSignature({ rawBody: "{}", headers: {} }),
    ).toThrow(/missing signature header/);
  });

  it("rejects a payload whose status is not one of the supported lifecycle outcomes", () => {
    const provider = createInMemoryTestPaymentProvider({ secret: "s" });
    const body = JSON.stringify({
      event: "weird",
      providerRef: "ref",
      status: "weird",
    });
    expect(() =>
      provider.verifyWebhookSignature({
        rawBody: body,
        headers: { "x-mt-test-signature": signTestWebhook("s", body) },
      }),
    ).toThrow(/unsupported webhook status/);
  });
});

/**
 * `InMemoryTestPaymentProvider` — pure-memory test double.
 *
 * Used by integration tests, dev environments, and storefront demos
 * before a real provider plugin is installed. The provider tracks
 * payments in a `Map<paymentId, { ... }>` and supports the documented
 * test hints:
 *
 *   - `metadata.code === "TEST_PENDING_*"` — `initiate` returns
 *     `{ status: "pending" }`. The test then drives the payment
 *     forward via `capture` (or a webhook).
 *
 *   - `metadata.code === "TEST_REDIRECT_*"` — `initiate` returns
 *     `{ status: "redirect", redirectUrl: "https://example.test/pay/<ref>" }`.
 *
 *   - default — `initiate` returns `{ status: "captured" }` (the happy path).
 *
 *   - `metadata.code === "TEST_FAIL"` — `initiate` throws (simulates
 *     a 5xx from the upstream provider).
 *
 * `verifyWebhookSignature` accepts an HMAC-SHA256 signature of the raw
 * body, computed against a per-provider secret. The signature is
 * supplied via the `x-mt-test-signature` header. The payload schema is
 * the canonical `(event, providerRef, status, raw)` tuple — tests
 * construct it with `signTestWebhook(secret, payload)` from this same
 * file so they do not hand-roll the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { id } from "@mt-commerce/core/ulid";
import type {
  CaptureInput,
  CaptureResult,
  FetchStatusInput,
  FetchStatusResult,
  InitiateInput,
  InitiateResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "./types.js";

export const IN_MEMORY_TEST_PROVIDER_CODE = "in_memory_test";
const SIGNATURE_HEADER = "x-mt-test-signature";

/** Default signing secret — overridable per instance for tests that want a specific secret. */
const DEFAULT_TEST_SECRET = "in-memory-test-provider-secret";

interface InMemoryState {
  status: "pending" | "captured" | "failed" | "refunded";
  providerRef: string;
  amount: bigint;
}

export interface InMemoryTestProviderOptions {
  /** HMAC secret used to verify webhook signatures. Defaults to a fixed test value. */
  secret?: string;
}

export interface InMemoryTestPaymentProvider extends PaymentProvider {
  /** Direct read of the in-memory state — tests assert on this. */
  inspect(paymentId: string): InMemoryState | undefined;
  /** Drive a payment forward without going through `capture`. */
  forceState(paymentId: string, state: InMemoryState): void;
  /** The HMAC secret in use; tests use it to sign webhook fixtures. */
  readonly secret: string;
}

export function createInMemoryTestPaymentProvider(
  options: InMemoryTestProviderOptions = {},
): InMemoryTestPaymentProvider {
  const state = new Map<string, InMemoryState>();
  const secret = options.secret ?? DEFAULT_TEST_SECRET;

  function readCode(metadata: Record<string, unknown> | undefined): string {
    if (!metadata) return "";
    const value = metadata.code;
    return typeof value === "string" ? value : "";
  }

  return {
    code: IN_MEMORY_TEST_PROVIDER_CODE,
    secret,

    async initiate(input: InitiateInput): Promise<InitiateResult> {
      const code = readCode(input.metadata);

      if (code === "TEST_FAIL") {
        // Simulates an upstream provider 5xx so the service's failure
        // path (record `failure` attempt, leave the payment `pending`)
        // is exercised by a test without a real network call.
        throw new Error("in-memory test provider: simulated failure");
      }

      const providerRef = `test_${id("ref").slice(4)}`;
      const amount = input.payment.amount;

      if (code.startsWith("TEST_PENDING_")) {
        state.set(input.payment.id, { status: "pending", providerRef, amount });
        return { status: "pending", providerRef, rawResponse: { code } };
      }

      if (code.startsWith("TEST_REDIRECT_")) {
        state.set(input.payment.id, { status: "pending", providerRef, amount });
        return {
          status: "redirect",
          providerRef,
          redirectUrl: `https://example.test/pay/${providerRef}`,
          rawResponse: { code },
        };
      }

      // Default — synchronous capture.
      state.set(input.payment.id, { status: "captured", providerRef, amount });
      return {
        status: "captured",
        providerRef,
        rawResponse: { code: code || null },
      };
    },

    async capture(input: CaptureInput): Promise<CaptureResult> {
      const existing = state.get(input.payment.id);
      if (!existing) {
        // No prior `initiate` for this payment id — test setup error.
        // Fail loud rather than silently fabricating a record.
        throw new Error(
          `in-memory test provider: capture called for unknown paymentId ${input.payment.id}`,
        );
      }
      state.set(input.payment.id, { ...existing, status: "captured" });
      return {
        status: "captured",
        rawResponse: { providerRef: existing.providerRef },
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const existing = state.get(input.payment.id);
      if (!existing) {
        throw new Error(
          `in-memory test provider: refund called for unknown paymentId ${input.payment.id}`,
        );
      }
      state.set(input.payment.id, { ...existing, status: "refunded" });
      return {
        status: "refunded",
        rawResponse: {
          providerRef: existing.providerRef,
          amount: input.amount?.toString() ?? existing.amount.toString(),
          reason: input.reason ?? null,
        },
      };
    },

    verifyWebhookSignature(input: VerifyWebhookInput): VerifiedWebhook {
      // Header lookup is case-insensitive against a lower-cased map.
      const signature = input.headers[SIGNATURE_HEADER];
      if (!signature || signature.trim().length === 0) {
        throw new Error("in-memory test provider: missing signature header");
      }
      const expected = signTestWebhook(secret, input.rawBody);
      if (!safeEqualHex(signature.trim(), expected)) {
        throw new Error("in-memory test provider: signature mismatch");
      }

      // Parse the verified body and project into the canonical tuple.
      // The test fixture writer controls the JSON shape — we look for
      // `{ event, providerRef, status, ... }` and pass the rest through
      // as `rawPayload`.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(input.rawBody) as Record<string, unknown>;
      } catch {
        throw new Error("in-memory test provider: webhook body is not JSON");
      }
      const event = typeof payload.event === "string" ? payload.event : "";
      const providerRef =
        typeof payload.providerRef === "string" ? payload.providerRef : "";
      const status = payload.status;
      if (!event || !providerRef) {
        throw new Error(
          "in-memory test provider: webhook body missing event/providerRef",
        );
      }
      if (
        status !== "captured" &&
        status !== "failed" &&
        status !== "refunded"
      ) {
        throw new Error(
          `in-memory test provider: unsupported webhook status "${String(status)}"`,
        );
      }
      return {
        event,
        providerRef,
        status,
        rawPayload: payload,
      };
    },

    /**
     * Reconciliation seam — reads from the in-memory state map. Tests
     * use `forceState` to simulate the upstream provider settling a
     * pending payment "out of band" (the equivalent of a buyer
     * completing a VA transfer outside the platform's flow), then
     * call `service.reconcilePayment` to drive the catch-up.
     *
     * Returns `null` when no state was ever recorded — analogous to
     * Midtrans's 404 for an expired Snap session.
     */
    async fetchStatus(
      input: FetchStatusInput,
    ): Promise<FetchStatusResult | null> {
      const existing = state.get(input.payment.id);
      if (!existing) return null;
      return {
        providerRef: existing.providerRef,
        status: existing.status,
        rawPayload: {
          source: "in_memory_test",
          providerRef: existing.providerRef,
          status: existing.status,
          amount: existing.amount.toString(),
        },
      };
    },

    inspect(paymentId) {
      return state.get(paymentId);
    },

    forceState(paymentId, next) {
      state.set(paymentId, next);
    },
  };
}

/**
 * Helper for tests: produce the hex HMAC-SHA256 signature for a raw
 * webhook body. Signed with the same secret the provider verifies
 * against.
 */
export function signTestWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time equality for two hex strings. We compare the decoded
 * byte buffers rather than the strings themselves so the comparison
 * does not short-circuit on the first differing character.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

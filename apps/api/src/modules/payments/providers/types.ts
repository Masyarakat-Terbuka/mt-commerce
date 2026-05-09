/**
 * `PaymentProvider` — the seam plugins implement.
 *
 * One method per lifecycle event: `initiate`, `capture`, `refund`,
 * `verifyWebhookSignature`. The provider does not know about the
 * `payments` row or the order; the service hands it the minimal
 * descriptor it needs and persists the result.
 *
 * Design notes:
 *
 *   - `code` is the public identifier the operator selects in checkout
 *     (`"midtrans"`, `"in_memory_test"`, ...). The registry keys by
 *     this string so plugins can register a provider without changes
 *     to the service.
 *
 *   - `initiate` returns one of three discriminated outcomes:
 *
 *       * `redirect`  — the provider expects the buyer to visit
 *                       `redirectUrl` (Snap, hosted-checkout flows).
 *                       The order stays `pending_payment`; the webhook
 *                       (or an admin capture) finalises it later.
 *       * `captured`  — the provider settled synchronously (card
 *                       authorisation + capture in one step). The
 *                       service transitions the order `pending_payment
 *                       → paid` immediately.
 *       * `pending`   — the charge is in-flight (offline transfer,
 *                       async settlement). Same handling as `redirect`
 *                       but with no URL to send the buyer to.
 *
 *     `providerRef` is required on every variant so we can resolve the
 *     payment from a later webhook delivery.
 *
 *   - `capture` is a no-op for providers that capture-on-initiate. It
 *     exists for the providers that authorise first and capture later
 *     (Stripe with `capture_method=manual`, e.g.). The service still
 *     records an attempt row for audit parity.
 *
 *   - `refund` accepts an optional `amount` for partial refunds. The
 *     service does not split a partial refund across multiple rows in
 *     v0.1 — a partial refund flips `status` to `refunded` and records
 *     the partial amount on the attempt's `requestPayload`. A future
 *     iteration can model partial refunds explicitly.
 *
 *   - `verifyWebhookSignature` is intentionally synchronous and throws
 *     on any verification failure (signature mismatch, missing header,
 *     unknown event). The service never proceeds with an unverified
 *     payload. The return shape projects the provider's payload into
 *     the canonical `(event, providerRef, status, rawPayload)` tuple
 *     so the dispatch path does not branch per provider.
 *
 * Reference implementation: `InMemoryTestPaymentProvider` in
 * `./in-memory.ts` — the pure-memory test double used by integration
 * tests and dev environments.
 */

/**
 * Outcome of `initiate`. Discriminated by `status` so callers can
 * narrow on the variant they care about.
 */
export type InitiateResult =
  | {
      status: "redirect";
      redirectUrl: string;
      providerRef: string;
      rawResponse?: unknown;
    }
  | {
      status: "captured";
      providerRef: string;
      rawResponse?: unknown;
    }
  | {
      status: "pending";
      providerRef: string;
      rawResponse?: unknown;
    };

export interface InitiateInput {
  payment: {
    id: string;
    orderId: string;
    amount: bigint;
    currency: string;
  };
  customer: {
    id: string | null;
    email: string;
    phone: string | null;
    name: string | null;
  };
  /** Free-form provider hints (`code: "TEST_PENDING_*"` for the test provider, plugin-specific options). */
  metadata?: Record<string, unknown>;
}

export interface CaptureInput {
  payment: { id: string; providerRef: string };
  /** Optional partial-capture amount; omit to capture the full authorised total. */
  amount?: bigint;
}

export interface CaptureResult {
  status: "captured";
  rawResponse?: unknown;
}

export interface RefundInput {
  payment: { id: string; providerRef: string };
  /** Optional partial-refund amount; omit to refund the full captured total. */
  amount?: bigint;
  /** Free-form reason recorded on the attempt and forwarded to the provider when supported. */
  reason?: string;
}

export interface RefundResult {
  status: "refunded";
  rawResponse?: unknown;
}

/**
 * Canonical shape the dispatcher accepts. Providers project their own
 * payload (Midtrans `notification`, Stripe `event`) into this tuple so
 * the service stays provider-agnostic.
 */
export interface VerifiedWebhook {
  /** Provider-specific event name, kept verbatim for the audit trail. */
  event: string;
  /** Provider's id for the payment this event refers to. */
  providerRef: string;
  /** Lifecycle outcome the event represents. */
  status: "captured" | "failed" | "refunded";
  /** The full payload as the provider sent it, for the audit row. */
  rawPayload: Record<string, unknown>;
}

export interface VerifyWebhookInput {
  /** Raw request body as text (signature schemes hash the bytes, not the parsed JSON). */
  rawBody: string;
  /** Lower-cased header map. The provider picks out the signature header by name. */
  headers: Record<string, string>;
}

export interface PaymentProvider {
  /** Stable identifier the operator selects in checkout. */
  readonly code: string;
  /** Begin a charge. Returns redirect, immediate capture, or pending. */
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Capture an authorised payment. No-op for capture-on-initiate providers. */
  capture(input: CaptureInput): Promise<CaptureResult>;
  /** Refund — full or partial. */
  refund(input: RefundInput): Promise<RefundResult>;
  /** Verify a webhook payload's signature. Throws on mismatch. */
  verifyWebhookSignature(input: VerifyWebhookInput): VerifiedWebhook;
  /**
   * Optional. Query the upstream provider for the canonical status of
   * the given payment and return a snapshot. Used by the reconciliation
   * path to recover from missed webhooks.
   *
   * Returns `null` when the provider has no record of this payment.
   * Throws on transport errors so the service records a failure
   * attempt and leaves the payment row untouched.
   */
  fetchStatus?(input: FetchStatusInput): Promise<FetchStatusResult | null>;
}

export interface FetchStatusInput {
  payment: { id: string; orderId: string; providerRef: string | null };
}

/**
 * Canonical projection the service expects from `fetchStatus`. The
 * status enum here mirrors the `PaymentStatus` machine, including
 * `pending` so the reconciler can recognise "still in flight" without
 * mapping the absence of a transition as a transition.
 */
export interface FetchStatusResult {
  providerRef: string;
  status: "pending" | "captured" | "failed" | "refunded";
  rawPayload: Record<string, unknown>;
}

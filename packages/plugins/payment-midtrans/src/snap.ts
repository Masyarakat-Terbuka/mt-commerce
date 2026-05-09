/**
 * Thin HTTP client for the Midtrans Snap and Core APIs.
 *
 * Why hand-rolled instead of the official SDK:
 *
 *   - The plugin's surface is two endpoints (Snap `/transactions`,
 *     Core `/v2/{orderId}/refund`). The official SDK pulls in `axios`
 *     and a couple hundred kB of middleware we do not need.
 *
 *   - The brief constraint is "no new top-level deps" — the Snap client
 *     uses native `fetch` and the signature uses `node:crypto`.
 *
 *   - Tests inject a `fetch` stub; vitest's `vi.fn()` is enough to
 *     assert request shape without a transport layer fixture.
 *
 * Auth: every request carries a Basic-auth header where the username is
 * the merchant's server key and the password is empty. The header is
 * computed once per client instance (the encoding is deterministic).
 *
 * Error handling: any non-2xx response throws a `MidtransApiError`
 * carrying the HTTP status, the parsed JSON body (when JSON), and the
 * raw text body (always). The provider translates this into the
 * platform's domain error at the boundary.
 */

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** Public Snap base URLs, switched by the plugin's `mode` option. */
export const SNAP_BASE_URLS = Object.freeze({
  sandbox: "https://app.sandbox.midtrans.com/snap/v1",
  production: "https://app.midtrans.com/snap/v1",
} as const);

/**
 * Public Core API base URLs. Used for refunds (and a future direct-debit
 * flow). Distinct from Snap because the Core API serves a different
 * function — Snap is the hosted-checkout layer, Core is the transaction
 * lifecycle layer.
 */
export const CORE_BASE_URLS = Object.freeze({
  sandbox: "https://api.sandbox.midtrans.com",
  production: "https://api.midtrans.com",
} as const);

export type MidtransMode = "sandbox" | "production";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when Midtrans returns a non-2xx response or the response body
 * cannot be parsed as JSON when JSON was expected. Carries enough context
 * for the platform's audit trail to record the failure verbatim.
 */
export class MidtransApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly endpoint: string;

  constructor(input: {
    message: string;
    status: number;
    body: unknown;
    endpoint: string;
  }) {
    super(input.message);
    this.name = "MidtransApiError";
    this.status = input.status;
    this.body = input.body;
    this.endpoint = input.endpoint;
  }
}

// ---------------------------------------------------------------------------
// Snap response shapes
// ---------------------------------------------------------------------------

export interface SnapTransactionResponse {
  /** Snap transaction token. Pair with `redirect_url` for the redirect flow. */
  readonly token: string;
  /** Hosted-checkout URL the buyer should be sent to. */
  readonly redirect_url: string;
}

export interface MidtransRefundResponse {
  readonly status_code: string;
  readonly status_message: string;
  readonly transaction_id: string;
  readonly order_id: string;
  readonly gross_amount: string;
  readonly refund_amount?: string;
  readonly refund_key?: string;
}

/**
 * Subset of Midtrans's `GET /v2/{order_id}/status` response that the
 * reconciliation path consumes. Midtrans returns more fields (masked
 * card, payment type, channel response code, etc.) but the platform
 * only needs the lifecycle ones — `transaction_id` becomes the
 * canonical `providerRef`, `transaction_status` + `fraud_status` map
 * to the platform's `(captured|failed|refunded|pending)` enum via
 * `mapMidtransStatus`.
 *
 * Marked `Partial`-ish on purpose: a 404 short-circuits to `null`
 * before this shape is constructed, but the live shape carries every
 * field listed below for non-404 responses.
 */
export interface MidtransStatusResponse {
  readonly status_code: string;
  readonly status_message: string;
  readonly transaction_id: string;
  readonly order_id: string;
  readonly transaction_status: string;
  readonly fraud_status?: string;
  readonly gross_amount: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Injection seam for tests. Defaults to global `fetch` (Node 18+, Bun,
 * Deno) at construction time so test fakes can override per instance
 * without monkeypatching the global.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Sentinel returned by `getTransactionStatus` when Midtrans replies
 * with 404 (transaction not found). Distinct from `null` on a network
 * failure — the latter throws — so callers can treat "unknown to the
 * provider" as a domain outcome rather than an exception.
 */
export const TRANSACTION_NOT_FOUND = Symbol("midtrans-transaction-not-found");
export type TransactionNotFound = typeof TRANSACTION_NOT_FOUND;

export interface SnapClientOptions {
  readonly serverKey: string;
  readonly mode?: MidtransMode;
  /** Test seam — defaults to `globalThis.fetch`. */
  readonly fetchImpl?: FetchLike;
}

export class SnapClient {
  private readonly authHeader: string;
  private readonly snapBase: string;
  private readonly coreBase: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SnapClientOptions) {
    if (!options.serverKey || options.serverKey.trim() === "") {
      throw new Error(
        "SnapClient: serverKey is required (set MIDTRANS_SERVER_KEY in mt-commerce.config.ts)",
      );
    }
    const mode = options.mode ?? "sandbox";
    this.snapBase = SNAP_BASE_URLS[mode];
    this.coreBase = CORE_BASE_URLS[mode];
    // Midtrans Basic auth: base64(serverKey + ":"). Empty password is
    // documented; the trailing colon is required for the standard
    // userinfo encoding.
    this.authHeader = `Basic ${Buffer.from(`${options.serverKey}:`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    if (!this.fetchImpl) {
      throw new Error(
        "SnapClient: no fetch implementation available — pass `fetchImpl` or run on Node 18+/Bun",
      );
    }
  }

  /**
   * POST `/snap/v1/transactions` to obtain a Snap token + redirect URL
   * for the given Snap transaction request body.
   */
  async createTransaction(
    body: Record<string, unknown>,
  ): Promise<SnapTransactionResponse> {
    const endpoint = `${this.snapBase}/transactions`;
    const json = await this.postJson<SnapTransactionResponse>(endpoint, body);
    if (
      typeof json.token !== "string" ||
      typeof json.redirect_url !== "string"
    ) {
      throw new MidtransApiError({
        message:
          "Snap /transactions response missing token or redirect_url; check Midtrans dashboard configuration",
        status: 200,
        body: json,
        endpoint,
      });
    }
    return json;
  }

  /**
   * GET `/v2/{orderId}/status` against the Core API to read the
   * canonical state of a Midtrans transaction. Used by the
   * reconciliation path to recover from missed webhooks: the platform
   * asks Midtrans "what's the current status?" and feeds the answer
   * through the same state machine the webhook handler uses.
   *
   * Returns `TRANSACTION_NOT_FOUND` when Midtrans replies 404 — this
   * is a real outcome (e.g. a Snap token expired before the buyer
   * paid), not a transport failure. Other non-2xx responses throw a
   * `MidtransApiError` so the caller can surface a typed failure on
   * the audit trail.
   */
  async getTransactionStatus(
    orderId: string,
  ): Promise<MidtransStatusResponse | TransactionNotFound> {
    const endpoint = `${this.coreBase}/v2/${encodeURIComponent(orderId)}/status`;
    const response = await this.fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: this.authHeader,
      },
    });
    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new MidtransApiError({
        message: `Midtrans returned non-JSON body (status ${response.status})`,
        status: response.status,
        body: text,
        endpoint,
      });
    }

    // Midtrans signals "not found" with HTTP 404 AND a `status_code`
    // body field of "404" (the transport status alone matches; we
    // double-check the body so a malformed proxy can't fake one). Any
    // other non-2xx is a real error.
    if (response.status === 404) {
      return TRANSACTION_NOT_FOUND;
    }
    if (!response.ok) {
      const message =
        extractErrorMessage(parsed) ?? `Midtrans HTTP ${response.status}`;
      throw new MidtransApiError({
        message,
        status: response.status,
        body: parsed,
        endpoint,
      });
    }

    return parsed as MidtransStatusResponse;
  }

  /**
   * POST `/v2/{orderId}/refund` against the Core API. Midtrans matches
   * the refund target by the Snap `order_id` (which the plugin sets to
   * the platform's payment id), NOT by the Snap token.
   *
   * `refund_key` is a per-refund idempotency handle generated by the
   * caller. The plugin uses the platform's idempotency key when
   * available, falling back to a fresh ULID — so a retry of the same
   * refund call against Midtrans is a no-op on Midtrans's side.
   */
  async refund(input: {
    orderId: string;
    refundKey: string;
    amount?: number;
    reason?: string;
  }): Promise<MidtransRefundResponse> {
    const endpoint = `${this.coreBase}/v2/${encodeURIComponent(input.orderId)}/refund`;
    const body: Record<string, unknown> = {
      refund_key: input.refundKey,
    };
    if (typeof input.amount === "number") body.amount = input.amount;
    if (input.reason) body.reason = input.reason;
    return this.postJson<MidtransRefundResponse>(endpoint, body);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async postJson<T>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new MidtransApiError({
        message: `Midtrans returned non-JSON body (status ${response.status})`,
        status: response.status,
        body: text,
        endpoint,
      });
    }
    if (!response.ok) {
      const message =
        extractErrorMessage(parsed) ?? `Midtrans HTTP ${response.status}`;
      throw new MidtransApiError({
        message,
        status: response.status,
        body: parsed,
        endpoint,
      });
    }
    return parsed as T;
  }
}

/**
 * Midtrans returns errors as either `{ status_message: "..." }` or
 * `{ error_messages: ["..."] }`. We coalesce so callers get a single
 * human-readable message regardless of the variant.
 */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = body as {
    status_message?: unknown;
    error_messages?: unknown;
  };
  if (typeof candidate.status_message === "string") {
    return candidate.status_message;
  }
  if (Array.isArray(candidate.error_messages)) {
    const messages = candidate.error_messages.filter(
      (m): m is string => typeof m === "string",
    );
    if (messages.length > 0) return messages.join("; ");
  }
  return undefined;
}

/**
 * Errors thrown by `@mt-commerce/sdk`.
 *
 * Every failure mode the client can produce surfaces as a single `ApiError`
 * type. Branching is by `code`, not by `instanceof` on a class hierarchy —
 * the same shape covers HTTP errors with a server-supplied envelope, network
 * failures (timeouts, aborts, transport errors) and decode failures.
 *
 * Stable codes used by the v0.1 client:
 *
 *   - "request_aborted"  — caller passed a signal that was aborted
 *   - "request_timeout"  — built-in timeout fired (default 5s)
 *   - "network_error"    — fetch threw before a response was received
 *   - "decode_error"     — server returned a body we could not parse
 *   - any code from the API's standard error envelope (e.g. "not_found",
 *     "validation_error", "unauthorized", "rate_limited", ...)
 *
 * Server error envelope from ARCHITECTURE.md:
 *
 *   { "error": { "code": "snake_case_code", "message": "...", "details": {...} } }
 */
export type ApiErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  public readonly code: string;
  /**
   * HTTP status code. `0` for client-side failures that never reached a
   * response (timeouts, aborts, transport errors).
   */
  public readonly status: number;
  public readonly details: ApiErrorDetails;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    details?: ApiErrorDetails;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.details = args.details ?? {};
    if (args.cause !== undefined) {
      (this as { cause?: unknown }).cause = args.cause;
    }
  }
}

/**
 * Type guard for the API's standard error envelope. Used to safely extract
 * `code`/`message`/`details` from a parsed JSON body without trusting the
 * shape blindly.
 */
export function isApiErrorEnvelope(
  body: unknown,
): body is { error: { code: string; message: string; details?: ApiErrorDetails } } {
  if (typeof body !== "object" || body === null) return false;
  const env = (body as { error?: unknown }).error;
  if (typeof env !== "object" || env === null) return false;
  const e = env as { code?: unknown; message?: unknown };
  return typeof e.code === "string" && typeof e.message === "string";
}

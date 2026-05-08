/**
 * Webhook signature verification for Midtrans Core API / Snap notifications.
 *
 * Per Midtrans documentation, every webhook payload includes a
 * `signature_key` field computed as:
 *
 *   SHA512(order_id + status_code + gross_amount + ServerKey)
 *
 * Reference: https://docs.midtrans.com/docs/https-notification-webhooks
 *
 * Notes on the formula:
 *
 *   - All four inputs are concatenated as ASCII strings, NOT JSON-encoded.
 *   - `gross_amount` arrives as a decimal string (e.g. `"50000.00"`) and
 *     must be used verbatim — re-formatting it (stripping the `.00`,
 *     normalizing leading zeros) breaks the hash.
 *   - The hash is hex-encoded (lowercase) before comparison.
 *   - Comparison is constant-time to defeat timing attacks against the
 *     hex string.
 *
 * The function is pure and synchronous; it has no I/O and depends only on
 * `node:crypto`'s `createHash` + `timingSafeEqual`.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The minimal subset of a Midtrans notification body needed for signature
 * verification. Real payloads carry many more fields (transaction_status,
 * payment_type, fraud_status, ...) — those are read by the dispatcher
 * AFTER the signature has been verified.
 */
export interface MidtransNotificationForSignature {
  readonly order_id: string;
  readonly status_code: string;
  readonly gross_amount: string;
  readonly signature_key: string;
}

/**
 * Compute the expected signature for a notification given the merchant's
 * server key. Exposed for tests and for diagnostic logging — production
 * verification should use {@link verifyMidtransSignature} so the comparison
 * is constant-time.
 */
export function computeMidtransSignature(input: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  serverKey: string;
}): string {
  const payload = `${input.orderId}${input.statusCode}${input.grossAmount}${input.serverKey}`;
  return createHash("sha512").update(payload, "utf8").digest("hex");
}

/**
 * Verify the `signature_key` on a Midtrans notification. Returns `true`
 * when the signature matches, `false` otherwise. Returns `false` (rather
 * than throwing) so the caller can decide between 401 vs structured error
 * — the plugin's `verifyWebhookSignature` returns the boolean directly to
 * the platform, which translates `false` to a 401 response.
 *
 * Defensive checks: missing or non-string fields short-circuit to `false`
 * so a malformed body (truncated upload, attacker probing) does not throw
 * inside the hashing layer.
 */
export function verifyMidtransSignature(
  notification: Partial<MidtransNotificationForSignature>,
  serverKey: string,
): boolean {
  const { order_id, status_code, gross_amount, signature_key } = notification;
  if (
    typeof order_id !== "string" ||
    typeof status_code !== "string" ||
    typeof gross_amount !== "string" ||
    typeof signature_key !== "string"
  ) {
    return false;
  }
  const expected = computeMidtransSignature({
    orderId: order_id,
    statusCode: status_code,
    grossAmount: gross_amount,
    serverKey,
  });
  return safeEqualHex(signature_key.trim().toLowerCase(), expected);
}

/**
 * Constant-time hex-string equality. We decode both sides into byte
 * buffers so the comparison does not short-circuit on the first
 * differing character. Any decode error (odd length, non-hex chars)
 * returns `false`.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

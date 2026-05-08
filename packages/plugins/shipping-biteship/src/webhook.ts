/**
 * Webhook verification + event mapping for Biteship tracking callbacks.
 *
 * Biteship signs callbacks with HMAC-SHA256 of the raw request body using
 * the operator's webhook secret, sent in the `x-biteship-signature`
 * header (lowercase header, hex-encoded digest). Always check the live
 * docs (https://biteship.com/id/docs/api/webhooks) before changing the
 * algorithm or header name — vendors evolve.
 *
 * `verifyWebhook` returns a discriminated result rather than throwing so
 * the api route layer can map verification failures to a 401 without
 * unwinding through an exception. `parseWebhook` returns a normalized
 * {@link BiteshipWebhookEvent} the route layer hands to the shipping
 * service for the matching state transition.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BiteshipWebhookEvent,
  BiteshipWebhookEventKind,
} from "./types.js";

export const BITESHIP_SIGNATURE_HEADER = "x-biteship-signature";

export interface VerifyWebhookInput {
  /** The raw request body string, exactly as received over the wire. */
  readonly rawBody: string;
  /**
   * Case-insensitive header map. The api passes a normalized record from
   * its Hono request; tests pass a literal object.
   */
  readonly headers: Record<string, string | undefined>;
  /** The secret operators paste from the Biteship dashboard. */
  readonly secret: string;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "missing_secret" | "bad_signature" };

/**
 * Verify the HMAC-SHA256 signature on a Biteship webhook. Constant-time
 * compare via `timingSafeEqual` so we do not leak the secret through
 * response-time variation.
 *
 * Returns a discriminated result so the route layer can branch on the
 * specific failure reason for logging without losing the security
 * invariant (any non-`ok: true` outcome is a 401).
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  if (!input.secret) {
    return { ok: false, reason: "missing_secret" };
  }
  const provided = lookupHeader(input.headers, BITESHIP_SIGNATURE_HEADER);
  if (!provided) {
    return { ok: false, reason: "missing_signature" };
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody, "utf8")
    .digest("hex");
  // Buffers must be the same length for timingSafeEqual to succeed
  // without throwing — short-circuit when lengths differ to avoid the
  // throw and still keep the comparison constant-time on equal-length
  // input.
  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Map a Biteship event status to mt-commerce's fulfillment events. Any
 * status that is not a meaningful state transition for v0.1 maps to
 * `"ignored"` — the route layer still 200s on those (Biteship retries
 * on non-2xx, so silently ignoring noise is the correct behaviour).
 *
 * Mapping reference (Biteship tracking event statuses):
 *   - `picked_up`, `picked`, `pickup`     → fulfillment.shipped
 *   - `dropping_off`, `on_delivery`, `out_for_delivery`,
 *     `delivering`, `in_transit`         → fulfillment.shipped (first one wins)
 *   - `delivered`                         → fulfillment.delivered
 *   - everything else (allocated, scheduled, problem, returned, ...) → ignored
 *
 * The plugin does NOT attempt to map cancelled/returned to a fulfillment
 * cancel — those involve operator decisions and the api models them
 * through admin actions, not webhook side effects.
 */
const STATUS_MAP: Record<string, BiteshipWebhookEventKind> = {
  picked_up: "fulfillment.shipped",
  picked: "fulfillment.shipped",
  pickup: "fulfillment.shipped",
  dropping_off: "fulfillment.shipped",
  on_delivery: "fulfillment.shipped",
  out_for_delivery: "fulfillment.shipped",
  delivering: "fulfillment.shipped",
  in_transit: "fulfillment.shipped",
  delivered: "fulfillment.delivered",
};

export function mapBiteshipStatus(status: string): BiteshipWebhookEventKind {
  return STATUS_MAP[status.toLowerCase()] ?? "ignored";
}

/**
 * Parse a verified Biteship tracking webhook body. Callers MUST run
 * `verifyWebhook` first — `parseWebhook` does not re-verify, it only
 * normalizes the payload shape.
 *
 * Throws when the body is not the expected shape (missing `order_id`,
 * missing `status`). The route layer should map the throw to a 400.
 */
export function parseWebhook(rawBody: string): BiteshipWebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    throw new Error(
      `Biteship webhook body is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof body !== "object" || body === null) {
    throw new Error("Biteship webhook body is not an object.");
  }
  const obj = body as Record<string, unknown>;
  const providerRef = stringField(obj, "order_id");
  if (!providerRef) {
    throw new Error("Biteship webhook body missing order_id.");
  }
  const biteshipStatus = stringField(obj, "status") ?? "";
  if (!biteshipStatus) {
    throw new Error("Biteship webhook body missing status.");
  }
  const trackingCode =
    stringField(obj, "courier_tracking_id") ??
    stringField(obj, "courier_waybill_id") ??
    stringField(obj, "waybill_id") ??
    null;
  const occurredAt = parseDate(
    stringField(obj, "updated_at") ?? stringField(obj, "created_at"),
  );

  return {
    kind: mapBiteshipStatus(biteshipStatus),
    providerRef,
    trackingCode,
    biteshipStatus,
    occurredAt,
    raw: obj,
  };
}

function lookupHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  // Hono normalizes to lowercase, but accept either to be defensive
  // against a route that forwards the headers object verbatim.
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

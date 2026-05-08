/**
 * Pure helpers that build a Midtrans Snap `/transactions` request from
 * the platform's `PaymentIntentLike` + customer descriptor. Kept separate
 * from `provider.ts` so the request shape can be unit-tested without
 * spinning up the provider class or stubbing fetch.
 *
 * Two small responsibilities:
 *
 *   1. {@link buildSnapTransactionRequest} — the JSON body POSTed to
 *      `/snap/v1/transactions`. Maps our normalized fields into the keys
 *      Midtrans expects (`transaction_details`, `customer_details`,
 *      `enabled_payments`, `callbacks`).
 *
 *   2. {@link mapMidtransStatus} — projects a Midtrans
 *      `transaction_status` (settlement / capture / cancel / expire / ...)
 *      into the platform's tri-state outcome (captured / failed / refunded)
 *      or signals "ignore this event" (pending, authorize). Exported so
 *      the API's webhook dispatcher can reuse the same mapping when
 *      forwarding verified notifications to the payments service.
 *
 * Why the IDR rounding here: ADR-0007 stores money as `bigint` in the
 * smallest unit of the currency. For IDR the smallest unit IS the
 * rupiah — there is no minor unit. Snap's `gross_amount` is an integer
 * rupiah value (Midtrans rejects non-integer amounts for IDR), so the
 * conversion is a no-op cast. For other currencies (USD, ...) the
 * platform stores cents; we divide by 100 because Midtrans's `gross_amount`
 * is in major units. Midtrans only formally supports IDR for most channels
 * but the conversion is correct in both cases.
 */
import type { Money } from "@mt-commerce/core/money";

// ---------------------------------------------------------------------------
// Customer + intent descriptors
// ---------------------------------------------------------------------------

/**
 * Customer fields the provider forwards to Midtrans. All fields are
 * optional from Midtrans's POV — the API enforces email/phone presence
 * upstream, but the plugin tolerates missing values (an email-less
 * checkout still succeeds; Midtrans omits the field).
 */
export interface SnapCustomerDescriptor {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}

/**
 * Default set of Snap payment channels enabled for a transaction. Mirrors
 * what most Indonesian merchants want out of the box: instant rails
 * (QRIS, GoPay, ShopeePay), virtual accounts for the major banks, credit
 * card, and over-the-counter cash at Indomaret/Alfamart.
 *
 * Operators can override per-transaction by passing `metadata.enabledPayments`
 * (string[]) at `initiate` time — the Snap docs accept any of the channel
 * codes listed here:
 * https://docs.midtrans.com/docs/snap-api-overview-snap
 */
export const DEFAULT_SNAP_ENABLED_PAYMENTS: readonly string[] = Object.freeze([
  // Instant rails
  "qris",
  "gopay",
  "shopeepay",
  // Virtual accounts (bank transfer)
  "bca_va",
  "bni_va",
  "bri_va",
  "permata_va",
  "echannel", // Mandiri Bill Payment (mandiri_va equivalent on Snap)
  // Cards
  "credit_card",
  // Over-the-counter cash
  "indomaret",
  "alfamart",
]);

// ---------------------------------------------------------------------------
// Snap request builder
// ---------------------------------------------------------------------------

export interface SnapTransactionRequest {
  readonly transaction_details: {
    readonly order_id: string;
    readonly gross_amount: number;
  };
  readonly customer_details?: {
    readonly first_name?: string;
    readonly last_name?: string;
    readonly email?: string;
    readonly phone?: string;
  };
  readonly enabled_payments?: readonly string[];
  readonly callbacks?: {
    readonly finish?: string;
    readonly error?: string;
    readonly pending?: string;
  };
  readonly credit_card?: {
    readonly secure: true;
  };
  readonly custom_field1?: string;
  readonly custom_field2?: string;
  readonly custom_field3?: string;
}

export interface BuildSnapRequestInput {
  /**
   * The platform's payment id. Used as Midtrans `order_id` so a webhook
   * notification can be looked up by the same key the plugin emitted.
   * Midtrans constrains this to 50 chars, alphanumeric plus `-_+,.~ /:`;
   * the platform's ULID-prefixed ids (`pay_<26>` ≈ 30 chars) fit.
   */
  readonly paymentId: string;
  /** Payment amount (typed Money). Currency is read for the unit conversion. */
  readonly amount: Money;
  readonly customer?: SnapCustomerDescriptor;
  /** Snap callback URLs — wire to the storefront's order-confirmed page. */
  readonly callbacks?: {
    readonly finish?: string;
    readonly error?: string;
    readonly pending?: string;
  };
  /** Operator-supplied override for `enabled_payments`. */
  readonly enabledPayments?: readonly string[];
  /**
   * Optional custom fields. Midtrans returns these in webhook
   * notifications, useful for cross-referencing the originating order
   * without re-querying.
   */
  readonly customFields?: {
    readonly customField1?: string;
    readonly customField2?: string;
    readonly customField3?: string;
  };
}

/**
 * Build the Snap `/transactions` request body. Pure — no I/O, no time
 * dependence. The provider passes the result straight to the Snap client.
 */
export function buildSnapTransactionRequest(
  input: BuildSnapRequestInput,
): SnapTransactionRequest {
  const grossAmount = moneyToSnapAmount(input.amount);

  const customer = pickCustomerDetails(input.customer);

  const callbacks = pickCallbacks(input.callbacks);

  const enabledPayments =
    input.enabledPayments && input.enabledPayments.length > 0
      ? input.enabledPayments
      : DEFAULT_SNAP_ENABLED_PAYMENTS;

  const request: Mutable<SnapTransactionRequest> = {
    transaction_details: {
      order_id: input.paymentId,
      gross_amount: grossAmount,
    },
    enabled_payments: enabledPayments,
    // 3DS for cards is the safe default in Indonesia. Operators who
    // explicitly want to disable 3DS can fork; we do not expose a
    // toggle since charging without 3DS is generally a fraud risk.
    credit_card: { secure: true },
  };

  if (customer) request.customer_details = customer;
  if (callbacks) request.callbacks = callbacks;

  if (input.customFields?.customField1)
    request.custom_field1 = input.customFields.customField1;
  if (input.customFields?.customField2)
    request.custom_field2 = input.customFields.customField2;
  if (input.customFields?.customField3)
    request.custom_field3 = input.customFields.customField3;

  return request;
}

/**
 * Convert a `Money` value to the integer Midtrans expects in
 * `gross_amount`. Midtrans is whole-rupiah for IDR; it tolerates
 * fractional amounts for some currencies but pessimistically we
 * always round to the nearest integer of the major unit.
 *
 * `Number(bigint)` is safe up to `Number.MAX_SAFE_INTEGER` (~9e15) —
 * vastly larger than any single payment a merchant would push through
 * Snap (~3 trillion IDR cap per Midtrans docs). For currencies the
 * platform stores in cents (USD), divide by 100; otherwise the bigint
 * is already a major-unit value.
 */
function moneyToSnapAmount(money: Money): number {
  // We avoid importing minor-unit metadata from core to keep the dep
  // surface minimal — the only currency Midtrans formally supports is
  // IDR (no minor unit). For non-IDR (forward-compat with international
  // operators experimenting with Snap), divide by 100 as the standard
  // assumption. This is intentionally conservative.
  if (money.currency === "IDR") {
    return Number(money.amount);
  }
  // Round to nearest integer major-unit. We do NOT use bigint division
  // (which truncates) because cents-of-1 should round to 0.01, then to
  // 0 (or 1 for 50+) for the major-unit gross_amount Snap expects.
  // The cast to Number is safe at typical commerce magnitudes.
  return Math.round(Number(money.amount) / 100);
}

function pickCustomerDetails(
  customer: SnapCustomerDescriptor | undefined,
): SnapTransactionRequest["customer_details"] | undefined {
  if (!customer) return undefined;

  const result: Mutable<NonNullable<SnapTransactionRequest["customer_details"]>> = {};
  const { first, last } = splitName(customer.name);
  if (first) result.first_name = first;
  if (last) result.last_name = last;
  if (customer.email) result.email = customer.email;
  if (customer.phone) result.phone = customer.phone;

  return Object.keys(result).length > 0 ? result : undefined;
}

function splitName(
  full: string | null | undefined,
): { first?: string; last?: string } {
  if (!full || full.trim() === "") return {};
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] };
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  return { first, last };
}

function pickCallbacks(
  callbacks: BuildSnapRequestInput["callbacks"],
): SnapTransactionRequest["callbacks"] | undefined {
  if (!callbacks) return undefined;
  const result: Mutable<NonNullable<SnapTransactionRequest["callbacks"]>> = {};
  if (callbacks.finish) result.finish = callbacks.finish;
  if (callbacks.error) result.error = callbacks.error;
  if (callbacks.pending) result.pending = callbacks.pending;
  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Notification status mapping
// ---------------------------------------------------------------------------

/**
 * Midtrans `transaction_status` values, per
 * https://docs.midtrans.com/docs/payment-status-handling. Listed
 * exhaustively so the mapping function can be exhaustive.
 */
export type MidtransTransactionStatus =
  | "settlement"
  | "capture"
  | "pending"
  | "authorize"
  | "deny"
  | "cancel"
  | "expire"
  | "failure"
  | "refund"
  | "partial_refund";

/**
 * The platform's lifecycle outcomes (matching the API's `VerifiedWebhook.status`).
 * `ignore` is a fourth case unique to Midtrans: `pending` and `authorize`
 * notifications carry no state change relevant to the platform's payment
 * row (which is already `pending` from `initiate`). The webhook dispatcher
 * acks them but does not transition.
 */
export type MidtransMappedOutcome = "captured" | "failed" | "refunded" | "ignore";

/**
 * Project a Midtrans transaction status onto the platform's lifecycle.
 *
 *   - `settlement`     → captured (final settlement for VA / cash / QRIS / GoPay)
 *   - `capture`        → captured ONLY when fraud_status is `accept` (cards)
 *   - `cancel|expire|deny|failure` → failed
 *   - `refund|partial_refund`      → refunded
 *   - `pending|authorize`          → ignore (no state change)
 *
 * `fraud_status` is consulted because a card `capture` with
 * `fraud_status === "challenge"` is NOT a confirmed capture — it is a
 * fraud-review hold that may resolve to `accept` (settlement) or `deny`
 * later. We treat `challenge` as ignore so the platform does not flip
 * the order to `paid` on a still-pending fraud review.
 */
export function mapMidtransStatus(
  status: string,
  fraudStatus?: string,
): MidtransMappedOutcome {
  switch (status) {
    case "settlement":
      return "captured";
    case "capture":
      // Card auto-capture: trust only when the fraud review accepted.
      // `fraud_status` is undefined for non-card flows; treat absent as
      // accepted because non-card capture events do not carry the field.
      if (!fraudStatus || fraudStatus === "accept") return "captured";
      if (fraudStatus === "challenge") return "ignore";
      return "failed";
    case "deny":
    case "cancel":
    case "expire":
    case "failure":
      return "failed";
    case "refund":
    case "partial_refund":
      return "refunded";
    case "pending":
    case "authorize":
      return "ignore";
    default:
      // Unknown status: ignore rather than throw, so a future Midtrans
      // status code does not crash the webhook handler. The dispatcher
      // logs the unknown event for diagnostics.
      return "ignore";
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

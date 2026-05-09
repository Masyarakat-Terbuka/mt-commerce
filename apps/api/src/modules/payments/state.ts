/**
 * Payment status state machine — pure helpers, no I/O.
 *
 * Mirrors the orders module's `state.ts` shape so the two surfaces stay
 * symmetric (a future reviewer reading either file knows what to expect
 * from the other).
 *
 * Diagram:
 *
 *   pending ───► authorized ───► captured ───► refunded
 *      │             │              │
 *      │             ├──► failed    ├──► failed
 *      │             └──► cancelled └──► cancelled
 *      ├──► captured (capture-on-initiate providers)
 *      ├──► failed
 *      └──► cancelled
 *
 * Allowed transitions (also captured in TRANSITIONS below):
 *   - pending      → authorized | captured | failed | cancelled
 *   - authorized   → captured | failed | cancelled
 *   - captured     → refunded | failed | cancelled
 *   - failed       → (terminal)
 *   - refunded     → (terminal)
 *   - cancelled    → (terminal)
 *
 * `failed` is terminal — a failed charge is the customer's signal to
 * try a different method. The service refuses re-initiating against the
 * same `payments` row; the storefront writes a fresh row instead. This
 * keeps the audit trail honest about what happened on each attempt.
 */

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded"
  | "cancelled";

const TRANSITIONS: Record<PaymentStatus, ReadonlyArray<PaymentStatus>> = {
  pending: ["authorized", "captured", "failed", "cancelled"],
  authorized: ["captured", "failed", "cancelled"],
  captured: ["refunded", "failed", "cancelled"],
  failed: [],
  refunded: [],
  cancelled: [],
};

export const ALL_PAYMENT_STATUSES: ReadonlyArray<PaymentStatus> = [
  "pending",
  "authorized",
  "captured",
  "failed",
  "refunded",
  "cancelled",
];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return status === "failed" || status === "refunded" || status === "cancelled";
}

export type PaymentAttemptKind =
  | "initiate"
  | "capture"
  | "refund"
  | "webhook"
  /**
   * Status was driven by an out-of-band reconciliation: the platform
   * polled the provider (or an admin clicked "reconcile") and the
   * provider's canonical state was applied to the payment row. Distinct
   * from `"webhook"` so the audit trail attributes the transition to
   * the polling path rather than a delivered notification.
   */
  | "reconcile";
export type PaymentAttemptStatus = "pending" | "success" | "failure";

export const ALL_PAYMENT_ATTEMPT_KINDS: ReadonlyArray<PaymentAttemptKind> = [
  "initiate",
  "capture",
  "refund",
  "webhook",
  "reconcile",
];

export const ALL_PAYMENT_ATTEMPT_STATUSES: ReadonlyArray<PaymentAttemptStatus> =
  ["pending", "success", "failure"];

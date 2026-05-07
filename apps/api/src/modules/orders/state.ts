/**
 * Order status state machine — pure helpers, no I/O.
 *
 * Centralises the "is this transition allowed" decision so the service
 * cannot accidentally diverge from the documented diagram. The truth
 * table lives here as a `Record<OrderStatus, ReadonlyArray<OrderStatus>>`
 * and is exhaustively unit-tested in `tests/modules/orders/state.test.ts`.
 *
 * Diagram:
 *
 *   pending_payment ──► paid ──► fulfilled ──► refunded
 *                  │       │           │
 *                  │       ├──► cancelled
 *                  │       └──► refunded
 *                  └──► cancelled
 *
 * Allowed transitions (also captured in TRANSITIONS below):
 *   - pending_payment → paid               (payment captured)
 *   - pending_payment → cancelled          (e.g. unpaid expiration)
 *   - paid             → fulfilled         (shipping handed off)
 *   - paid             → cancelled         (rare; kicks off refund track)
 *   - paid             → refunded          (direct refund)
 *   - fulfilled        → refunded          (post-shipment refund)
 *
 * Terminal states: `cancelled`, `refunded`. A refund cannot be undone via
 * the state machine — operators issue a new order if needed.
 *
 * Note: `cancelled` is terminal in v0.1. The `paid → cancelled` edge above
 * is kept because operators may need to mark a paid order as cancelled
 * BEFORE the refund flow runs (e.g. payment captured but the buyer
 * disputed). The refund itself is recorded via `paid → refunded` or
 * `fulfilled → refunded`. A future iteration may add `cancelled →
 * refunded` once we model partial refunds explicitly.
 */

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "refunded";

const TRANSITIONS: Record<OrderStatus, ReadonlyArray<OrderStatus>> = {
  pending_payment: ["paid", "cancelled"],
  paid: ["fulfilled", "cancelled", "refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionsFor(
  from: OrderStatus,
): ReadonlyArray<OrderStatus> {
  return TRANSITIONS[from];
}

export function isTerminal(status: OrderStatus): boolean {
  return status === "cancelled" || status === "refunded";
}

export const ALL_ORDER_STATUSES: ReadonlyArray<OrderStatus> = [
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
];

/**
 * The lifecycle-timestamp column on `orders` that should be set when an
 * order transitions INTO `status`. Used by the service to denormalise
 * `paid_at` / `fulfilled_at` / `cancelled_at` / `refunded_at` from the
 * audit log. Returning `null` means the transition has no associated
 * timestamp column (today: only the initial `pending_payment` placement).
 */
export function timestampColumnFor(
  status: OrderStatus,
):
  | "paidAt"
  | "fulfilledAt"
  | "cancelledAt"
  | "refundedAt"
  | null {
  switch (status) {
    case "paid":
      return "paidAt";
    case "fulfilled":
      return "fulfilledAt";
    case "cancelled":
      return "cancelledAt";
    case "refunded":
      return "refundedAt";
    case "pending_payment":
    default:
      return null;
  }
}

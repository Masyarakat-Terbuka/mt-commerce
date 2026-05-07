/**
 * Checkout state machine — pure helpers, no I/O.
 *
 * Centralizes the "is this transition allowed" decision so the service
 * cannot accidentally diverge from the documented diagram. The truth table
 * lives here as a `Record<CheckoutState, ReadonlyArray<CheckoutState>>` and
 * is exhaustively unit-tested in `tests/modules/checkout/state.test.ts`.
 *
 * Diagram (mirrors README and the v0.1 checklist):
 *
 *   pending ──► awaiting_shipping ──► awaiting_payment ──► completed
 *                                                       ↘ failed
 *
 * Forward-only with two relaxations:
 *
 *   1. From `awaiting_shipping` and `awaiting_payment`, the customer can
 *      revise upstream choices. We model "revise the address" as
 *      `awaiting_payment → awaiting_shipping` (a backward transition into
 *      the prior data-collection state) and "re-set address" as
 *      `awaiting_shipping → awaiting_shipping` (self-loop, allowed). The
 *      service wires these to the dedicated PUT endpoints.
 *
 *   2. Any non-terminal state can transition to `failed` via the
 *      cancel endpoint.
 *
 * Terminal states (`completed`, `failed`) have no outgoing transitions —
 * a checkout that has reached either is frozen forever. A customer who
 * needs to retry after a failure starts a new checkout from the same cart.
 */

export type CheckoutState =
  | "pending"
  | "awaiting_shipping"
  | "awaiting_payment"
  | "completed"
  | "failed";

/**
 * Adjacency map of allowed transitions. Self-loops express "re-enter the
 * same state with new data" (e.g. switch shipping address again before
 * picking a shipping method).
 *
 * The set is intentionally small and readable. If a future state needs an
 * extra hop (e.g. a `processing_payment` interstitial), add it here and
 * extend the union type — the test matrix will fail until every cell is
 * covered.
 */
const TRANSITIONS: Record<CheckoutState, ReadonlyArray<CheckoutState>> = {
  pending: ["awaiting_shipping", "failed"],
  awaiting_shipping: [
    "awaiting_shipping", // re-set addresses
    "awaiting_payment",
    "failed",
  ],
  awaiting_payment: [
    "awaiting_shipping", // revise addresses
    "awaiting_payment", // revise shipping selection
    "completed",
    "failed",
  ],
  completed: [],
  failed: [],
};

/**
 * `true` iff `from → to` is permitted by the diagram. Self-loops on
 * `awaiting_shipping` and `awaiting_payment` are intentionally permitted
 * (revise data without leaving the state).
 */
export function canTransition(
  from: CheckoutState,
  to: CheckoutState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The set of states reachable from `from`. Useful for the admin events
 * panel ("what could this row do next?") and as the test-matrix axis.
 */
export function transitionsFor(
  from: CheckoutState,
): ReadonlyArray<CheckoutState> {
  return TRANSITIONS[from];
}

export function isTerminal(state: CheckoutState): boolean {
  return state === "completed" || state === "failed";
}

export const ALL_CHECKOUT_STATES: ReadonlyArray<CheckoutState> = [
  "pending",
  "awaiting_shipping",
  "awaiting_payment",
  "completed",
  "failed",
];

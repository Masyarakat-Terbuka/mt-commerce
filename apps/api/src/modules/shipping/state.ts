/**
 * Fulfillment status state machine — pure helpers, no I/O.
 *
 * Mirrors `orders/state.ts` in shape so a future "all status diagrams in
 * one place" doc can render them side-by-side.
 *
 * Diagram:
 *
 *   pending ──► shipped ──► delivered
 *           ↘           ↘
 *             cancelled    cancelled
 *
 * Allowed transitions:
 *   - pending  → shipped     (operator marked shipped, possibly with tracking)
 *   - pending  → cancelled   (operator cancelled before hand-off)
 *   - shipped  → delivered   (courier confirmed delivery; operator marks)
 *   - shipped  → cancelled   (rare — undeliverable, RTS, etc.)
 *
 * Terminal states: `delivered`, `cancelled`. Neither can be undone via the
 * state machine; an operator who needs to revert issues a new fulfillment
 * (which would drive a refund + reship via the orders module).
 */
import type { FulfillmentStatus } from "./types.js";

const TRANSITIONS: Record<FulfillmentStatus, ReadonlyArray<FulfillmentStatus>> =
  {
    pending: ["shipped", "cancelled"],
    shipped: ["delivered", "cancelled"],
    delivered: [],
    cancelled: [],
  };

export function canTransition(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionsFor(
  from: FulfillmentStatus,
): ReadonlyArray<FulfillmentStatus> {
  return TRANSITIONS[from];
}

export function isTerminal(status: FulfillmentStatus): boolean {
  return status === "delivered" || status === "cancelled";
}

export const ALL_FULFILLMENT_STATUSES: ReadonlyArray<FulfillmentStatus> = [
  "pending",
  "shipped",
  "delivered",
  "cancelled",
];

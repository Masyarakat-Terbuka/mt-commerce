/**
 * Order status state machine — pure unit tests.
 *
 * Pinning the truth table here means the diagram in `state.ts` and the
 * documentation in the README cannot silently diverge from the runtime
 * behaviour. Adding or removing a status should fail at least one test.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_ORDER_STATUSES,
  canTransition,
  isTerminal,
  timestampColumnFor,
  transitionsFor,
  type OrderStatus,
} from "../../../src/modules/orders/state.js";

const ALLOWED: ReadonlyArray<{ from: OrderStatus; to: OrderStatus }> = [
  { from: "pending_payment", to: "paid" },
  { from: "pending_payment", to: "cancelled" },
  { from: "paid", to: "fulfilled" },
  { from: "paid", to: "cancelled" },
  { from: "paid", to: "refunded" },
  { from: "fulfilled", to: "refunded" },
];

describe("order status state machine", () => {
  it("permits exactly the diagrammed transitions", () => {
    for (const { from, to } of ALLOWED) {
      expect(
        canTransition(from, to),
        `expected ${from} → ${to} to be allowed`,
      ).toBe(true);
    }
  });

  it("rejects every transition not in the diagram", () => {
    for (const from of ALL_ORDER_STATUSES) {
      for (const to of ALL_ORDER_STATUSES) {
        const allowed = ALLOWED.some((p) => p.from === from && p.to === to);
        if (allowed) continue;
        expect(
          canTransition(from, to),
          `expected ${from} → ${to} to be denied`,
        ).toBe(false);
      }
    }
  });

  it("treats `cancelled` as terminal — no outgoing transitions", () => {
    for (const to of ALL_ORDER_STATUSES) {
      expect(canTransition("cancelled", to)).toBe(false);
    }
    expect(transitionsFor("cancelled")).toHaveLength(0);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("treats `refunded` as terminal — no outgoing transitions", () => {
    for (const to of ALL_ORDER_STATUSES) {
      expect(canTransition("refunded", to)).toBe(false);
    }
    expect(transitionsFor("refunded")).toHaveLength(0);
    expect(isTerminal("refunded")).toBe(true);
  });

  it("`isTerminal` is false for non-terminal statuses", () => {
    expect(isTerminal("pending_payment")).toBe(false);
    expect(isTerminal("paid")).toBe(false);
    expect(isTerminal("fulfilled")).toBe(false);
  });

  it("never permits a self-loop on any status", () => {
    for (const status of ALL_ORDER_STATUSES) {
      expect(
        canTransition(status, status),
        `unexpected self-loop on ${status}`,
      ).toBe(false);
    }
  });

  it("maps each transition to the right `<status>_at` column", () => {
    expect(timestampColumnFor("paid")).toBe("paidAt");
    expect(timestampColumnFor("fulfilled")).toBe("fulfilledAt");
    expect(timestampColumnFor("cancelled")).toBe("cancelledAt");
    expect(timestampColumnFor("refunded")).toBe("refundedAt");
    // The initial placement has no associated timestamp column —
    // `created_at` is the marker.
    expect(timestampColumnFor("pending_payment")).toBeNull();
  });
});

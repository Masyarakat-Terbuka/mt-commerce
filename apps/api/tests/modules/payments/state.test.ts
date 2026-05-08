/**
 * Payment status state machine — exhaustive transition table.
 *
 * The matrix mirrors the orders/state tests so a future regression in
 * the diagram is caught at the cheapest layer (a single failing
 * assertion) rather than as a transition error from a routes test.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PAYMENT_STATUSES,
  canTransition,
  isTerminal,
  type PaymentStatus,
} from "../../../src/modules/payments/state.js";

const ALLOWED: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
  ["pending", "authorized"],
  ["pending", "captured"],
  ["pending", "failed"],
  ["pending", "cancelled"],
  ["authorized", "captured"],
  ["authorized", "failed"],
  ["authorized", "cancelled"],
  ["captured", "refunded"],
  ["captured", "failed"],
  ["captured", "cancelled"],
];

describe("payments state machine", () => {
  it("permits every documented transition and refuses every other pair", () => {
    for (const from of ALL_PAYMENT_STATUSES) {
      for (const to of ALL_PAYMENT_STATUSES) {
        if (from === to) continue;
        const isAllowed = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to)).toBe(isAllowed);
      }
    }
  });

  it("flags failed / refunded / cancelled as terminal", () => {
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("authorized")).toBe(false);
    expect(isTerminal("captured")).toBe(false);
  });
});

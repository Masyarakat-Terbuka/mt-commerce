/**
 * Checkout state machine — pure unit tests.
 *
 * Pinning the truth table here means the diagram in `state.ts` and the
 * documentation in the README cannot silently diverge from the runtime
 * behavior. Adding or removing a state should fail at least one test.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CHECKOUT_STATES,
  canTransition,
  isTerminal,
  transitionsFor,
  type CheckoutState,
} from "../../../src/modules/checkout/state.js";

const ALLOWED: ReadonlyArray<{ from: CheckoutState; to: CheckoutState }> = [
  { from: "pending", to: "awaiting_shipping" },
  { from: "pending", to: "failed" },
  { from: "awaiting_shipping", to: "awaiting_shipping" }, // re-set addresses
  { from: "awaiting_shipping", to: "awaiting_payment" },
  { from: "awaiting_shipping", to: "failed" },
  { from: "awaiting_payment", to: "awaiting_shipping" }, // revise addresses
  { from: "awaiting_payment", to: "awaiting_payment" }, // revise shipping
  { from: "awaiting_payment", to: "completed" },
  { from: "awaiting_payment", to: "failed" },
];

describe("checkout state machine", () => {
  it("permits exactly the diagrammed transitions", () => {
    for (const { from, to } of ALLOWED) {
      expect(
        canTransition(from, to),
        `expected ${from} → ${to} to be allowed`,
      ).toBe(true);
    }
  });

  it("rejects every transition not in the diagram", () => {
    for (const from of ALL_CHECKOUT_STATES) {
      for (const to of ALL_CHECKOUT_STATES) {
        const allowed = ALLOWED.some((p) => p.from === from && p.to === to);
        if (allowed) continue;
        expect(
          canTransition(from, to),
          `expected ${from} → ${to} to be denied`,
        ).toBe(false);
      }
    }
  });

  it("treats `completed` as terminal — no outgoing transitions", () => {
    for (const to of ALL_CHECKOUT_STATES) {
      expect(canTransition("completed", to)).toBe(false);
    }
    expect(transitionsFor("completed")).toHaveLength(0);
    expect(isTerminal("completed")).toBe(true);
  });

  it("treats `failed` as terminal — no outgoing transitions", () => {
    for (const to of ALL_CHECKOUT_STATES) {
      expect(canTransition("failed", to)).toBe(false);
    }
    expect(transitionsFor("failed")).toHaveLength(0);
    expect(isTerminal("failed")).toBe(true);
  });

  it("permits revising addresses by stepping back to awaiting_shipping", () => {
    expect(canTransition("awaiting_payment", "awaiting_shipping")).toBe(true);
  });

  it("permits revising shipping by self-looping awaiting_payment", () => {
    expect(canTransition("awaiting_payment", "awaiting_payment")).toBe(true);
  });

  it("permits cancellation from every non-terminal state", () => {
    expect(canTransition("pending", "failed")).toBe(true);
    expect(canTransition("awaiting_shipping", "failed")).toBe(true);
    expect(canTransition("awaiting_payment", "failed")).toBe(true);
  });

  it("`isTerminal` returns false for non-terminal states", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("awaiting_shipping")).toBe(false);
    expect(isTerminal("awaiting_payment")).toBe(false);
  });
});

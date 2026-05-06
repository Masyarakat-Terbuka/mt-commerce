/**
 * Verifies the bigint JSON serialization contract from ADR-0007: amount values
 * cross the wire as decimal strings, never throw.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  installBigIntJsonSerializer,
  toJsonSafe,
} from "../../src/lib/json.js";

describe("toJsonSafe", () => {
  it("converts a bigint value to a string", () => {
    expect(toJsonSafe(100n)).toBe("100");
  });

  it("recursively converts bigint values inside objects and arrays", () => {
    expect(
      toJsonSafe({ amount: 100n, nested: { items: [1n, 2n] }, name: "x" }),
    ).toEqual({ amount: "100", nested: { items: ["1", "2"] }, name: "x" });
  });

  it("preserves Date objects through normal JSON serialization", () => {
    const d = new Date("2026-05-07T00:00:00.000Z");
    const result = toJsonSafe({ when: d }) as { when: Date };
    expect(result.when).toBeInstanceOf(Date);
  });
});

describe("installBigIntJsonSerializer", () => {
  it("makes Hono c.json() serialize { amount: 100n } as {\"amount\":\"100\"}", async () => {
    installBigIntJsonSerializer();
    const app = new Hono();
    app.get("/money", (c) => c.json({ amount: 100n }));

    const res = await app.request("/money");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toBe('{"amount":"100"}');
  });

  it("does not throw when serializing nested bigint values", async () => {
    installBigIntJsonSerializer();
    const app = new Hono();
    app.get("/order", (c) =>
      c.json({ totalCents: 1500000n, items: [{ priceCents: 750000n }] }),
    );

    const res = await app.request("/order");
    const json = (await res.json()) as {
      totalCents: string;
      items: Array<{ priceCents: string }>;
    };
    expect(json).toEqual({
      totalCents: "1500000",
      items: [{ priceCents: "750000" }],
    });
  });

  it("is idempotent — repeated installation does not throw", () => {
    expect(() => {
      installBigIntJsonSerializer();
      installBigIntJsonSerializer();
    }).not.toThrow();
  });
});

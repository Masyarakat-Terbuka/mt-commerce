import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BITESHIP_SIGNATURE_HEADER,
  mapBiteshipStatus,
  parseWebhook,
  verifyWebhook,
} from "../src/webhook.js";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyWebhook", () => {
  const secret = "whsec_super_secret";
  const body = JSON.stringify({ order_id: "biteship_o_1", status: "delivered" });

  it("accepts a valid signature", () => {
    const sig = sign(body, secret);
    const result = verifyWebhook({
      rawBody: body,
      headers: { [BITESHIP_SIGNATURE_HEADER]: sig },
      secret,
    });
    expect(result).toEqual({ ok: true });
  });

  it("normalizes header casing", () => {
    const sig = sign(body, secret);
    const result = verifyWebhook({
      rawBody: body,
      headers: { "X-Biteship-Signature": sig },
      secret,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the signature header is missing", () => {
    const result = verifyWebhook({ rawBody: body, headers: {}, secret });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects when the secret is missing", () => {
    const result = verifyWebhook({
      rawBody: body,
      headers: { [BITESHIP_SIGNATURE_HEADER]: "deadbeef" },
      secret: "",
    });
    expect(result).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("rejects a tampered body", () => {
    const sig = sign(body, secret);
    const result = verifyWebhook({
      rawBody: body + "x",
      headers: { [BITESHIP_SIGNATURE_HEADER]: sig },
      secret,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a different-length signature without throwing", () => {
    const result = verifyWebhook({
      rawBody: body,
      headers: { [BITESHIP_SIGNATURE_HEADER]: "abc" },
      secret,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("mapBiteshipStatus", () => {
  it("maps picked_up → fulfillment.shipped", () => {
    expect(mapBiteshipStatus("picked_up")).toBe("fulfillment.shipped");
  });

  it("maps in-transit-style statuses → fulfillment.shipped", () => {
    for (const s of ["dropping_off", "on_delivery", "out_for_delivery", "in_transit"]) {
      expect(mapBiteshipStatus(s)).toBe("fulfillment.shipped");
    }
  });

  it("maps delivered → fulfillment.delivered", () => {
    expect(mapBiteshipStatus("delivered")).toBe("fulfillment.delivered");
  });

  it("ignores noise statuses", () => {
    for (const s of ["allocated", "scheduled", "problem", "returned", ""]) {
      expect(mapBiteshipStatus(s)).toBe("ignored");
    }
  });

  it("is case-insensitive", () => {
    expect(mapBiteshipStatus("DELIVERED")).toBe("fulfillment.delivered");
    expect(mapBiteshipStatus("Picked_Up")).toBe("fulfillment.shipped");
  });
});

describe("parseWebhook", () => {
  it("extracts order_id, status, tracking, and timestamp", () => {
    const raw = JSON.stringify({
      order_id: "bo_1",
      status: "delivered",
      courier_tracking_id: "JNE-XYZ",
      updated_at: "2026-05-08T03:00:00Z",
    });
    const ev = parseWebhook(raw);
    expect(ev.kind).toBe("fulfillment.delivered");
    expect(ev.providerRef).toBe("bo_1");
    expect(ev.trackingCode).toBe("JNE-XYZ");
    expect(ev.biteshipStatus).toBe("delivered");
    expect(ev.occurredAt?.toISOString()).toBe("2026-05-08T03:00:00.000Z");
  });

  it("maps picked_up to fulfillment.shipped", () => {
    const raw = JSON.stringify({
      order_id: "bo_2",
      status: "picked_up",
      waybill_id: "WB-1",
    });
    const ev = parseWebhook(raw);
    expect(ev.kind).toBe("fulfillment.shipped");
    expect(ev.trackingCode).toBe("WB-1");
  });

  it("returns kind=ignored for an unrecognized status", () => {
    const raw = JSON.stringify({ order_id: "bo_3", status: "scheduled" });
    const ev = parseWebhook(raw);
    expect(ev.kind).toBe("ignored");
    expect(ev.providerRef).toBe("bo_3");
  });

  it("throws on missing order_id", () => {
    const raw = JSON.stringify({ status: "delivered" });
    expect(() => parseWebhook(raw)).toThrow(/order_id/);
  });

  it("throws on missing status", () => {
    const raw = JSON.stringify({ order_id: "bo_x" });
    expect(() => parseWebhook(raw)).toThrow(/status/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWebhook("not json")).toThrow(/JSON/);
  });
});

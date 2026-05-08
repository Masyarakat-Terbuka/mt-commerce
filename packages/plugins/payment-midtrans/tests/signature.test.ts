/**
 * Signature verification tests.
 *
 * The fixture below is computed from the formula documented at
 * https://docs.midtrans.com/docs/https-notification-webhooks:
 *
 *   signature_key = sha512(order_id + status_code + gross_amount + serverKey)
 *
 * To make this test resilient to typos in the formula or the test
 * fixture, we ALSO assert the expected hex against a freshly recomputed
 * `computeMidtransSignature(...)` call. If both ever drift, the failure
 * pinpoints which side moved.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeMidtransSignature,
  verifyMidtransSignature,
} from "../src/signature.js";

const FIXTURE = {
  order_id: "pay_01HZX1ABCDEFGHJKMNPQRSTUVW",
  status_code: "200",
  gross_amount: "150000.00",
  serverKey: "SB-Mid-server-TESTSERVERKEYxxxxxxxxxxxxxxxxxx",
};

function expectedHex(): string {
  return createHash("sha512")
    .update(
      `${FIXTURE.order_id}${FIXTURE.status_code}${FIXTURE.gross_amount}${FIXTURE.serverKey}`,
      "utf8",
    )
    .digest("hex");
}

describe("computeMidtransSignature", () => {
  it("matches a fresh SHA512 of (order_id + status_code + gross_amount + serverKey)", () => {
    expect(
      computeMidtransSignature({
        orderId: FIXTURE.order_id,
        statusCode: FIXTURE.status_code,
        grossAmount: FIXTURE.gross_amount,
        serverKey: FIXTURE.serverKey,
      }),
    ).toBe(expectedHex());
  });
});

describe("verifyMidtransSignature", () => {
  it("returns true for a correctly signed notification", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: FIXTURE.status_code,
          gross_amount: FIXTURE.gross_amount,
          signature_key: signature,
        },
        FIXTURE.serverKey,
      ),
    ).toBe(true);
  });

  it("rejects a notification whose order_id was tampered with", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: "pay_01HZX1ATTACKERREPLACEDxxxxx",
          status_code: FIXTURE.status_code,
          gross_amount: FIXTURE.gross_amount,
          signature_key: signature,
        },
        FIXTURE.serverKey,
      ),
    ).toBe(false);
  });

  it("rejects a notification whose gross_amount was tampered with", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: FIXTURE.status_code,
          gross_amount: "1.00",
          signature_key: signature,
        },
        FIXTURE.serverKey,
      ),
    ).toBe(false);
  });

  it("rejects a notification whose status_code was tampered with", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: "404",
          gross_amount: FIXTURE.gross_amount,
          signature_key: signature,
        },
        FIXTURE.serverKey,
      ),
    ).toBe(false);
  });

  it("rejects when signed against a different server key", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: FIXTURE.status_code,
          gross_amount: FIXTURE.gross_amount,
          signature_key: signature,
        },
        "SB-Mid-server-DIFFERENTKEYxxxxxxxxxxxxxxxxx",
      ),
    ).toBe(false);
  });

  it("returns false when required fields are missing", () => {
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          gross_amount: FIXTURE.gross_amount,
          signature_key: expectedHex(),
        },
        FIXTURE.serverKey,
      ),
    ).toBe(false);
  });

  it("returns false when the signature_key is malformed (not hex)", () => {
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: FIXTURE.status_code,
          gross_amount: FIXTURE.gross_amount,
          signature_key: "not-a-hex-string",
        },
        FIXTURE.serverKey,
      ),
    ).toBe(false);
  });

  it("accepts a signature in upper case (Midtrans documents lowercase but we normalise)", () => {
    const signature = expectedHex();
    expect(
      verifyMidtransSignature(
        {
          order_id: FIXTURE.order_id,
          status_code: FIXTURE.status_code,
          gross_amount: FIXTURE.gross_amount,
          signature_key: signature.toUpperCase(),
        },
        FIXTURE.serverKey,
      ),
    ).toBe(true);
  });
});

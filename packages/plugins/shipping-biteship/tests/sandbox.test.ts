/**
 * Real-sandbox tests, gated by `BITESHIP_SANDBOX_API_KEY`.
 *
 * Skipped by default. To run:
 *   BITESHIP_SANDBOX_API_KEY=test_xxx \
 *   BITESHIP_SANDBOX_ORIGIN_POSTAL=12345 \
 *   BITESHIP_SANDBOX_DEST_POSTAL=67890 \
 *   bun --filter @mt-commerce/plugin-shipping-biteship test
 *
 * These exist to catch upstream contract drift (Biteship adds/renames a
 * field, changes a status string). They never run in CI without the
 * secret being injected — keep them green when you do run them.
 */
import { describe, expect, it } from "vitest";
import { BiteshipShippingProvider } from "../src/provider.js";

const apiKey = process.env.BITESHIP_SANDBOX_API_KEY;
const originPostal = process.env.BITESHIP_SANDBOX_ORIGIN_POSTAL ?? "12345";
const destPostal = process.env.BITESHIP_SANDBOX_DEST_POSTAL ?? "67890";

const skip = !apiKey;

describe.skipIf(skip)("Biteship sandbox (live)", () => {
  it("returns a non-empty rate ladder for a 1kg parcel", async () => {
    const provider = new BiteshipShippingProvider({
      apiKey: apiKey!,
      mode: "sandbox",
      origin: { postalCode: originPostal },
    });
    const result = await provider.quoteRates(
      { code: "FREE_FOR_ALL", providerKind: "plugin", flatRate: null },
      {
        currency: "IDR",
        destination: { postalCode: destPostal },
        items: [
          { name: "Sandbox sample", quantity: 1, value: 100_000, weight: 1000 },
        ],
      },
    );
    expect(result.rates.length).toBeGreaterThan(0);
    expect(result.money.amount).toBeGreaterThan(0n);
    expect(result.money.currency).toBe("IDR");
  }, 30_000);
});

/**
 * Storefront tax routes — public, unauthenticated reads. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * The storefront calls `GET /storefront/v1/tax/rate?currency=IDR` to
 * preview the tax that will be applied at checkout. Returning the rate
 * (not a precomputed amount) lets the storefront defer the multiplication
 * to its own cart preview, which is fine because the cart's totals
 * endpoint also surfaces the applied rate.
 *
 * 404 when no default is configured for the requested currency, so
 * client code can branch on that rather than treating "no rate" as
 * "zero tax" implicitly.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import type { TaxService } from "../service.js";
import { getDefaultRateQuerySchema } from "../types.js";
import { toWireTaxRate } from "./wire.js";

function parseOrThrow<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      "Request validation failed.",
      issuesToDetails(result.error.issues),
    );
  }
  return result.data as z.infer<S>;
}

export function buildTaxStorefrontRoutes(
  service: TaxService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.get("/tax/rate", async (c) => {
    const query = parseOrThrow(
      getDefaultRateQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const rate = await service.getDefaultRate(query.currency);
    if (!rate) {
      throw new NotFoundError(
        "No default tax rate is configured for this currency.",
        { currency: query.currency },
      );
    }
    return c.json(toWireTaxRate(rate));
  });

  return router;
}

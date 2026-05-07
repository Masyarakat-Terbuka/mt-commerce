/**
 * Storefront shipping routes — public, unauthenticated reads + a
 * `quote` endpoint for the storefront's checkout flow. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * The storefront calls `GET /storefront/v1/shipping/methods?currency=IDR`
 * to render the shipping options, then `POST /storefront/v1/shipping/quote`
 * with `{ methodCode, currency }` to confirm the price right before
 * submitting the address+shipping selection to checkout.
 *
 * Method listing filters to `is_active = true AND deleted_at IS NULL` so
 * only orderable methods are visible to shoppers. The `currency` query
 * is accepted but advisory at v0.1 — manual methods carry a single
 * configured currency, so a mismatched currency simply yields a quote
 * the storefront will see as a `currency_mismatch` ValidationError when
 * it asks for a quote. Surfacing the per-currency filter as part of the
 * listing endpoint is left for the plugin-provider milestone.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import { toJSON as moneyToJSON } from "@mt-commerce/core/money";
import {
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import type { ShippingService } from "../service.js";
import {
  listShippingMethodsQuerySchema,
  quoteShippingSchema,
} from "../types.js";
import { toWireShippingMethod } from "./wire.js";

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }
}

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

export function buildShippingStorefrontRoutes(
  service: ShippingService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.get("/shipping/methods", async (c) => {
    // Storefront sees only active, non-deleted methods. Force the option
    // regardless of what the client asked for — `?activeOnly=false` from
    // a public caller would otherwise surface inactive rows.
    parseOrThrow(
      listShippingMethodsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const methods = await service.listMethods({ activeOnly: true });
    return c.json({
      data: methods.map((method) => toWireShippingMethod(method)),
    });
  });

  router.post("/shipping/quote", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(quoteShippingSchema, raw);
    const amount = await service.quote(input);
    return c.json({ amount: moneyToJSON(amount) });
  });

  return router;
}

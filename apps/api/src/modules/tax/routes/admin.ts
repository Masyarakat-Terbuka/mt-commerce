/**
 * Admin tax routes — staff-facing CRUD over tax rates plus an explicit
 * "set default" toggle. Mounted at `/admin/v1` from the top-level router.
 *
 * Auth: every route in this file requires a session-authenticated staff
 * user. The role gate accepts `owner|admin|staff` to match the catalog
 * and cart admin routers.
 *
 * Conventions:
 *   - Bodies are validated through Zod schemas exported from `../types.ts`.
 *   - Validation failures throw `ValidationError` so the standard error
 *     handler renders the consistent envelope.
 *   - Domain types are converted to wire shapes via `toWireTaxRate`.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { TaxService } from "../service.js";
import {
  createTaxRateSchema,
  listTaxRatesQuerySchema,
  updateTaxRateSchema,
} from "../types.js";
import { toWireTaxRate } from "./wire.js";

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

export function buildTaxAdminRoutes(service: TaxService): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.get("/tax/rates", async (c) => {
    const query = parseOrThrow(
      listTaxRatesQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const rates = await service.listRates({ activeOnly: query.activeOnly });
    return c.json({ data: rates.map((rate) => toWireTaxRate(rate)) });
  });

  router.post("/tax/rates", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createTaxRateSchema, raw);
    const rate = await service.createRate(input);
    return c.json(toWireTaxRate(rate), 201);
  });

  router.get("/tax/rates/:id", async (c) => {
    const rate = await service.getRateById(c.req.param("id"));
    if (!rate) throw new NotFoundError("Tax rate not found.");
    return c.json(toWireTaxRate(rate));
  });

  router.patch("/tax/rates/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateTaxRateSchema, raw);
    const rate = await service.updateRate(c.req.param("id"), patch);
    return c.json(toWireTaxRate(rate));
  });

  /**
   * Convenience flip: equivalent to PATCH with `{ isDefault: true }`.
   * Surfaced as its own endpoint so the admin UI's "set as default"
   * button maps to a single, intention-revealing call.
   */
  router.post("/tax/rates/:id/set-default", async (c) => {
    const rate = await service.updateRate(c.req.param("id"), {
      isDefault: true,
    });
    return c.json(toWireTaxRate(rate));
  });

  router.delete("/tax/rates/:id", async (c) => {
    await service.archiveRate(c.req.param("id"));
    return c.body(null, 204);
  });

  return router;
}

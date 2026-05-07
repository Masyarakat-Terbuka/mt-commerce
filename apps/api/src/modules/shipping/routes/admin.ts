/**
 * Admin shipping routes — staff-facing CRUD over shipping methods.
 * Mounted at `/admin/v1` from the top-level router.
 *
 * Auth: every route in this file requires a session-authenticated staff
 * user. The role gate accepts `owner|admin|staff`, mirroring the cart
 * and catalog admin routers.
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
import type { ShippingService } from "../service.js";
import {
  createShippingMethodSchema,
  listShippingMethodsQuerySchema,
  updateShippingMethodSchema,
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

export function buildShippingAdminRoutes(
  service: ShippingService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  router.get("/shipping/methods", async (c) => {
    const query = parseOrThrow(
      listShippingMethodsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    // Admin defaults to "show me everything" — but the schema's default
    // is `true`. Honour an explicit `?activeOnly=false` and keep the
    // default behaviour `true` for the storefront-shaped admin call.
    const methods = await service.listMethods({ activeOnly: query.activeOnly });
    return c.json({
      data: methods.map((method) => toWireShippingMethod(method)),
    });
  });

  router.post("/shipping/methods", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createShippingMethodSchema, raw);
    const method = await service.createMethod(input);
    return c.json(toWireShippingMethod(method), 201);
  });

  router.get("/shipping/methods/:id", async (c) => {
    const method = await service.getById(c.req.param("id"));
    if (!method) throw new NotFoundError("Shipping method not found.");
    return c.json(toWireShippingMethod(method));
  });

  router.patch("/shipping/methods/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateShippingMethodSchema, raw);
    const method = await service.updateMethod(c.req.param("id"), patch);
    return c.json(toWireShippingMethod(method));
  });

  router.delete("/shipping/methods/:id", async (c) => {
    await service.deleteMethod(c.req.param("id"));
    return c.body(null, 204);
  });

  return router;
}

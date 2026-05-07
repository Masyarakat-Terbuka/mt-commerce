/**
 * Admin catalog routes — staff-facing CRUD over products, variants,
 * categories, and inventory. Mounted at `/admin/v1` from the top-level
 * router.
 *
 * Auth: every route in this file requires a session-authenticated staff
 * user. The role gate accepts `owner`, `admin`, and `staff` — `viewer` is
 * read-only at the role level and intentionally NOT in the set, since this
 * router's surface is mutating. A future read-only `/admin/v1/catalog/...`
 * surface (if added) would gate on `viewer` plus the others.
 *
 * The middleware comes from the auth module's public contract per ADR-0005.
 * `requireAuth` runs first to populate `c.var.authUser`; `requireRole` then
 * looks up the staff profile and rejects with 403 if the role is not in
 * the accepted set.
 *
 * Conventions in this file:
 *   - Bodies are validated through the Zod schemas exported from `types.ts`.
 *   - On validation failure we throw `ValidationError` so the standard error
 *     handler renders the consistent `{ error: { code, message, details } }`
 *     envelope.
 *   - Domain types are converted to wire shapes by `toWireProduct`,
 *     `toWireVariant`, etc., which keep `bigint` amounts as
 *     `MoneyJSON` (string amounts) per ADR-0007.
 *   - Read paths accept `?locale=` so the admin can preview each locale
 *     without flipping a global UI setting; it follows the same resolution
 *     order as the storefront (query → Accept-Language → DEFAULT_LOCALE).
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
import {
  toWireCategory,
  toWireInventoryLevel,
  toWireProduct,
  toWireVariant,
} from "./wire.js";
import {
  adjustInventorySchema,
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  listProductsQuerySchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from "../types.js";
import type { CatalogService } from "../service.js";
import { localeFromRequest } from "./locale.js";

/**
 * Read JSON from a request, returning `undefined` for empty bodies and
 * surfacing parse errors as `invalid_json` to match the existing `/v1/ping`
 * pattern. Local copy rather than an import because we do not want to take a
 * dependency on the routes/v1 module.
 */
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

export function buildCatalogAdminRoutes(
  service: CatalogService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // Gate every route in this router. The auth module's middlewares populate
  // c.var.authUser and check the staff profile's role.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  // -------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------

  router.get("/products", async (c) => {
    const query = parseOrThrow(
      listProductsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const locale = localeFromRequest(c);
    const result = await service.listProducts({ ...query, locale });
    return c.json({
      data: result.data.map((p) => toWireProduct(p)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.post("/products", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createProductSchema, raw);
    const locale = localeFromRequest(c);
    const product = await service.createProduct(input, locale);
    return c.json(toWireProduct(product), 201);
  });

  router.get("/products/:id", async (c) => {
    const locale = localeFromRequest(c);
    const product = await service.getProductById(c.req.param("id"), locale);
    if (!product) throw new NotFoundError("Product not found.");
    return c.json(toWireProduct(product));
  });

  router.patch("/products/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateProductSchema, raw);
    const locale = localeFromRequest(c);
    const product = await service.updateProduct(c.req.param("id"), patch, locale);
    return c.json(toWireProduct(product));
  });

  router.delete("/products/:id", async (c) => {
    await service.softDeleteProduct(c.req.param("id"));
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------

  router.post("/products/:id/variants", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createVariantSchema, raw);
    const locale = localeFromRequest(c);
    const variant = await service.createVariant(c.req.param("id"), input, locale);
    return c.json(toWireVariant(variant), 201);
  });

  router.patch("/variants/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateVariantSchema, raw);
    const locale = localeFromRequest(c);
    const variant = await service.updateVariant(c.req.param("id"), patch, locale);
    return c.json(toWireVariant(variant));
  });

  router.delete("/variants/:id", async (c) => {
    await service.softDeleteVariant(c.req.param("id"));
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------

  router.get("/categories", async (c) => {
    const locale = localeFromRequest(c);
    const categories = await service.listCategories(locale);
    return c.json({ data: categories.map((cat) => toWireCategory(cat)) });
  });

  router.post("/categories", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createCategorySchema, raw);
    const locale = localeFromRequest(c);
    const category = await service.createCategory(input, locale);
    return c.json(toWireCategory(category), 201);
  });

  router.patch("/categories/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateCategorySchema, raw);
    const locale = localeFromRequest(c);
    const category = await service.updateCategory(c.req.param("id"), patch, locale);
    return c.json(toWireCategory(category));
  });

  router.delete("/categories/:id", async (c) => {
    await service.deleteCategory(c.req.param("id"));
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------

  router.post("/variants/:id/inventory/adjust", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(adjustInventorySchema, raw);
    const level = await service.adjustInventory(c.req.param("id"), input.delta);
    return c.json(toWireInventoryLevel(level));
  });

  return router;
}

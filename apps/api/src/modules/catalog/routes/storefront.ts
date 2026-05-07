/**
 * Storefront catalog routes — public, unauthenticated reads. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Differences from the admin routes:
 *   - Only `active`, non-soft-deleted products are visible. The service
 *     enforces this via `activeOnly: true`, never the route.
 *   - Filters use the `categorySlug` querystring (admin uses `categoryId`)
 *     because the storefront should not need to know IDs.
 *   - The category endpoint returns a flat list with `parent_id` so callers
 *     can build their own tree client-side. Document choice: flat over tree
 *     keeps the response simple and avoids a recursive payload that bloats
 *     for deeply nested categories. The storefront SDK will render a tree
 *     when needed.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import {
  toWireCategory,
  toWireProduct,
  type WireCategory,
} from "./wire.js";
import { listProductsQuerySchema } from "../types.js";
import type { CatalogService } from "../service.js";

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

export function buildCatalogStorefrontRoutes(
  service: CatalogService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.get("/products", async (c) => {
    const query = parseOrThrow(
      listProductsQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    // Storefront cannot select by `status` or see drafts. Strip the field
    // before handing to the service so a client-set `status=draft` is
    // ignored rather than silently honored.
    const safeQuery = { ...query, status: undefined };
    const result = await service.listProducts({ ...safeQuery, activeOnly: true });
    return c.json({
      data: result.data.map((p) => toWireProduct(p)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.get("/products/:slug", async (c) => {
    const product = await service.getProductBySlug(c.req.param("slug"), {
      activeOnly: true,
    });
    if (!product) throw new NotFoundError("Product not found.");
    return c.json(toWireProduct(product));
  });

  router.get("/categories", async (c) => {
    // Flat list with parent_id; the client builds the tree. See the file
    // comment for the rationale.
    const categories = await service.listCategories();
    const data: WireCategory[] = categories.map((cat) => toWireCategory(cat));
    return c.json({ data });
  });

  return router;
}

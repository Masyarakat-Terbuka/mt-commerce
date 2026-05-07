/**
 * Storefront catalog routes — public, unauthenticated reads. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Differences from the admin routes:
 *   - Only `active`, non-soft-deleted products are visible. The service
 *     enforces this via `activeOnly: true`, never the route.
 *   - Filters use the `categorySlug` querystring (admin uses `categoryId`)
 *     because the storefront should not need to know IDs.
 *   - Categories are returned as a flat list with `parentId` so callers
 *     build their own tree client-side. Flat over tree keeps the response
 *     simple and avoids a recursive payload that bloats for deeply nested
 *     categories.
 *   - Locale resolution: every read pulls the locale from
 *     `localeFromRequest(c)` (`?locale=` query → `Accept-Language` header →
 *     `DEFAULT_LOCALE`) and forwards it to the service so the response
 *     carries translated `title`/`description`/`name` strings per ADR-0010.
 *
 * OpenAPI: each route is declared via `createRoute`/`router.openapi(...)` so
 * it surfaces in `/openapi.json` with the same Zod schemas the runtime
 * validation enforces. Response shapes mirror the wire helpers.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { toWireCategory, toWireProduct } from "./wire.js";
import {
  CategoryListEnvelope,
  PaginatedProductWire,
  ProductWire,
} from "./openapi-schemas.js";
import { listProductsQuerySchema } from "../types.js";
import type { CatalogService } from "../service.js";
import { localeFromRequest } from "./locale.js";

const TAG = "catalog (storefront)";

const SlugParam = z.object({ slug: z.string().min(1) });

export function buildCatalogStorefrontRoutes(
  service: CatalogService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.openapi(
    createRoute({
      method: "get",
      path: "/products",
      tags: [TAG],
      summary: "List products (public)",
      description:
        "Returns active, non-deleted products. Supports `categorySlug`, `search`, price bounds, and sort. The `status` query field is ignored — drafts and archived items are never visible on the storefront.",
      request: { query: listProductsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedProductWire } },
          description: "Page of products.",
        },
        400: errorResponse("Invalid query."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      // Strip any client-supplied `status` so a `status=draft` is ignored
      // rather than silently honored.
      const safeQuery = { ...query, status: undefined };
      const locale = localeFromRequest(c);
      const result = await service.listProducts({
        ...safeQuery,
        activeOnly: true,
        locale,
      });
      return c.json(
        {
          data: result.data.map((p) => toWireProduct(p)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/products/{slug}",
      tags: [TAG],
      summary: "Get a product by slug (public)",
      request: { params: SlugParam },
      responses: {
        200: {
          content: { "application/json": { schema: ProductWire } },
          description: "Product.",
        },
        404: errorResponse("Not found or not active."),
      },
    }),
    async (c) => {
      const locale = localeFromRequest(c);
      const product = await service.getProductBySlug(c.req.param("slug"), {
        activeOnly: true,
        locale,
      });
      if (!product) throw new NotFoundError("Product not found.");
      return c.json(toWireProduct(product), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/categories",
      tags: [TAG],
      summary: "List categories (public)",
      description: "Flat list with `parentId` so clients can build a tree client-side.",
      responses: {
        200: {
          content: { "application/json": { schema: CategoryListEnvelope } },
          description: "Categories.",
        },
      },
    }),
    async (c) => {
      const locale = localeFromRequest(c);
      const categories = await service.listCategories(locale);
      return c.json({ data: categories.map((cat) => toWireCategory(cat)) }, 200);
    },
  );

  return router;
}

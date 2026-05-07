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
 * OpenAPI: routes are declared via `createRoute`/`router.openapi(...)` so
 * each endpoint shows up in `/openapi.json` with its request and response
 * schemas. Bodies are still validated through the same Zod schemas exported
 * from `types.ts`; the framework runs the parse from the route descriptor
 * instead of the handler calling `parseOrThrow`. Validation failures throw
 * `ZodError`, caught by the global error handler and rendered as the
 * standard `validation_error` envelope.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import {
  toWireCategory,
  toWireInventoryLevel,
  toWireProduct,
  toWireVariant,
} from "./wire.js";
import {
  CategoryListEnvelope,
  CategoryWire,
  InventoryLevelWire,
  PaginatedProductWire,
  ProductWire,
  VariantWire,
} from "./openapi-schemas.js";
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

const TAG = "catalog (admin)";

const IdParam = z.object({ id: z.string().min(1) });

export function buildCatalogAdminRoutes(
  service: CatalogService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  // Gate every route in this router. The auth module's middlewares populate
  // c.var.authUser and check the staff profile's role.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  // -------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "get",
      path: "/products",
      tags: [TAG],
      summary: "List products",
      description:
        "Paginated product list. Supports `categoryId`, `search`, price bounds, and sort. Translatable fields resolve from the locale chain (?locale, Accept-Language, default).",
      request: { query: listProductsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedProductWire } },
          description: "Page of products.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const locale = localeFromRequest(c);
      const result = await service.listProducts({ ...query, locale });
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
      method: "post",
      path: "/products",
      tags: [TAG],
      summary: "Create a product",
      description:
        "Create a product with a `translations` blob (see ADR-0010). Default locale must be present.",
      request: {
        body: {
          content: { "application/json": { schema: createProductSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: ProductWire } },
          description: "Created.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        409: errorResponse("Slug already in use."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const locale = localeFromRequest(c);
      const product = await service.createProduct(input, locale);
      return c.json(toWireProduct(product), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/products/{id}",
      tags: [TAG],
      summary: "Get a product by id",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: ProductWire } },
          description: "Product.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const locale = localeFromRequest(c);
      const product = await service.getProductById(c.req.param("id"), locale);
      if (!product) throw new NotFoundError("Product not found.");
      return c.json(toWireProduct(product), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/products/{id}",
      tags: [TAG],
      summary: "Update a product",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: updateProductSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: ProductWire } },
          description: "Updated.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const locale = localeFromRequest(c);
      const product = await service.updateProduct(
        c.req.param("id"),
        patch,
        locale,
      );
      return c.json(toWireProduct(product), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/products/{id}",
      tags: [TAG],
      summary: "Soft-delete a product",
      request: { params: IdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      await service.softDeleteProduct(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------
  // Variants
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "post",
      path: "/products/{id}/variants",
      tags: [TAG],
      summary: "Create a variant",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: createVariantSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: VariantWire } },
          description: "Created.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Parent product not found."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const locale = localeFromRequest(c);
      const variant = await service.createVariant(
        c.req.param("id"),
        input,
        locale,
      );
      return c.json(toWireVariant(variant), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/variants/{id}",
      tags: [TAG],
      summary: "Update a variant",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: updateVariantSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: VariantWire } },
          description: "Updated.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const locale = localeFromRequest(c);
      const variant = await service.updateVariant(
        c.req.param("id"),
        patch,
        locale,
      );
      return c.json(toWireVariant(variant), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/variants/{id}",
      tags: [TAG],
      summary: "Soft-delete a variant",
      request: { params: IdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      await service.softDeleteVariant(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "get",
      path: "/categories",
      tags: [TAG],
      summary: "List categories",
      description: "Flat list with `parentId`. Clients build a tree client-side.",
      responses: {
        200: {
          content: { "application/json": { schema: CategoryListEnvelope } },
          description: "Categories.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const locale = localeFromRequest(c);
      const categories = await service.listCategories(locale);
      return c.json({ data: categories.map((cat) => toWireCategory(cat)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/categories",
      tags: [TAG],
      summary: "Create a category",
      request: {
        body: {
          content: { "application/json": { schema: createCategorySchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: CategoryWire } },
          description: "Created.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        409: errorResponse("Slug already in use."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const locale = localeFromRequest(c);
      const category = await service.createCategory(input, locale);
      return c.json(toWireCategory(category), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/categories/{id}",
      tags: [TAG],
      summary: "Update a category",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: updateCategorySchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CategoryWire } },
          description: "Updated.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const locale = localeFromRequest(c);
      const category = await service.updateCategory(
        c.req.param("id"),
        patch,
        locale,
      );
      return c.json(toWireCategory(category), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/categories/{id}",
      tags: [TAG],
      summary: "Delete a category",
      request: { params: IdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      await service.deleteCategory(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "post",
      path: "/variants/{id}/inventory/adjust",
      tags: [TAG],
      summary: "Adjust inventory for a variant",
      description:
        "Apply a signed `delta` to the variant's available count. Bounded to ±1,000,000 to keep the value safely inside int4.",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: adjustInventorySchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: InventoryLevelWire } },
          description: "Updated inventory level.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Variant not found."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const level = await service.adjustInventory(
        c.req.param("id"),
        input.delta,
      );
      return c.json(toWireInventoryLevel(level), 200);
    },
  );

  return router;
}

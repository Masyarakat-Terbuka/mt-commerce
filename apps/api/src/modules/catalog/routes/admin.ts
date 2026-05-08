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
import { getAuthedUser, requireAuth, requireRole } from "../../auth/index.js";
import {
  toWireCategory,
  toWireInventoryAuditEntry,
  toWireInventoryLevel,
  toWireProduct,
  toWireVariant,
} from "./wire.js";
import {
  CategoryListEnvelope,
  CategoryWire,
  InventoryLevelWire,
  PaginatedInventoryAuditEntryWire,
  PaginatedInventoryLevelWire,
  PaginatedProductWire,
  ProductWire,
  VariantWire,
} from "./openapi-schemas.js";
import {
  adjustInventorySchema,
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  listInventoryAuditQuerySchema,
  listInventoryLevelsQuerySchema,
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
        "Apply a signed `delta` to the variant's available count. Bounded to ±1,000,000 to keep the value safely inside int4. The optional `reason` is persisted to the audit log alongside the actor and the before/after counts.",
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
      // The auth middleware already populated `c.var.authUser`; we resolve
      // it here so the audit row records the staff actor for this change.
      // API-key callers also surface as `staff` (the key is bound to a
      // user id) — the audit semantics are "the human or service who
      // authenticated to make this call," and the auth_user_id captures
      // that uniformly.
      const user = getAuthedUser(c);
      const level = await service.adjustInventory(
        c.req.param("id"),
        {
          delta: input.delta,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        { actor: { kind: "staff", userId: user.id } },
      );
      return c.json(toWireInventoryLevel(level), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/variants/{id}/inventory",
      tags: [TAG],
      summary: "Get the inventory level for a variant",
      description:
        "Returns the variant's single inventory row (location_id NULL in v0.1). 404 when the variant has no level row yet — every variant gets one on creation, so a 404 here means the variant id itself does not exist.",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: InventoryLevelWire } },
          description: "Inventory level.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("No inventory row for this variant."),
      },
    }),
    async (c) => {
      const level = await service.getInventory(c.req.param("id"));
      if (!level) {
        throw new NotFoundError("Inventory level not found for variant.", {
          variantId: c.req.param("id"),
        });
      }
      return c.json(toWireInventoryLevel(level), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/inventory/levels",
      tags: [TAG],
      summary: "List inventory levels",
      description:
        "Paginated list of inventory rows. `productId` narrows to one product's variants; without it, every variant is returned. Soft-deleted variants are excluded.",
      request: { query: listInventoryLevelsQuerySchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: PaginatedInventoryLevelWire },
          },
          description: "Page of inventory levels.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listInventoryLevels(query);
      return c.json(
        {
          data: result.data.map((level) => toWireInventoryLevel(level)),
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
      path: "/variants/{id}/inventory/audit",
      tags: [TAG],
      summary: "List inventory audit history for a variant",
      description:
        "Paginated audit_log rows where entity_kind=`inventory` and entity_id matches the variant id. Newest first. Each row carries the actor, the structured details (`deltaApplied`, `before`, `after`), the operator's `reason`, and the timestamp.",
      request: {
        params: IdParam,
        query: listInventoryAuditQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: PaginatedInventoryAuditEntryWire,
            },
          },
          description: "Page of audit events.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listInventoryAudit(
        c.req.param("id"),
        query,
      );
      return c.json(
        {
          data: result.data.map((event) => toWireInventoryAuditEntry(event)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
        200,
      );
    },
  );

  return router;
}

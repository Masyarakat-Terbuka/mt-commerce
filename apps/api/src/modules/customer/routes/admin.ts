/**
 * Admin customer routes — staff-facing CRUD over customers and their
 * addresses. Mounted at `/admin/v1` from the top-level router.
 *
 * Auth: every route in this file requires a session-authenticated staff
 * user. The role gate accepts `owner`, `admin`, and `staff` — `viewer` is
 * intentionally NOT in the set, since this router's surface is mutating
 * and the catalog admin router uses the same set. The middlewares come
 * from the auth module's public contract per ADR-0005.
 *
 * Without these gates, anyone reaching `/admin/v1/customers/*` could list,
 * read, modify, and soft-delete every customer — direct PII exposure.
 *
 * OpenAPI: routes are declared via `createRoute`/`router.openapi(...)` so
 * each shows up in `/openapi.json`. Bodies and queries are validated through
 * the same Zod schemas exported from `types.ts`; validation failures throw
 * `ZodError`, caught by the global error handler.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import { requireAuth, requireRole } from "../../auth/index.js";
import type { CustomerService } from "../service.js";
import {
  createAddressSchema,
  createCustomerSchema,
  listCustomersQuerySchema,
  updateAddressSchema,
  updateCustomerSchema,
} from "../types.js";
import { toWireAddress, toWireCustomer } from "./wire.js";
import {
  AddressListEnvelope,
  AddressWire,
  CustomerWire,
  CustomerWithAddressesWire,
  PaginatedCustomerWire,
} from "./openapi-schemas.js";

const TAG = "customer (admin)";

const IdParam = z.object({ id: z.string().min(1) });
const AddressIdParam = z.object({ addressId: z.string().min(1) });

export function buildCustomerAdminRoutes(
  service: CustomerService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  // Gate every route. The auth module's middlewares populate c.var.authUser
  // and check the staff profile's role. `viewer` is excluded because this
  // router's surface is mutating; matches catalog admin.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff"));

  // -------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "get",
      path: "/customers",
      tags: [TAG],
      summary: "List customers",
      description:
        "Paginated customer list. `email` and `search` narrow the result set; soft-deleted customers are excluded.",
      request: { query: listCustomersQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: PaginatedCustomerWire } },
          description: "Page of customers.",
        },
        400: errorResponse("Invalid query."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden — staff role required."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const result = await service.listCustomers({
        ...query,
        excludeDeleted: true,
      });
      return c.json(
        {
          data: result.data.map((cust) => toWireCustomer(cust)),
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
      path: "/customers",
      tags: [TAG],
      summary: "Create a customer",
      request: {
        body: {
          content: { "application/json": { schema: createCustomerSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: CustomerWire } },
          description: "Created.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        409: errorResponse("Email already in use."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const customer = await service.createCustomer(input);
      return c.json(toWireCustomer(customer), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/customers/{id}",
      tags: [TAG],
      summary: "Get a customer (with addresses)",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: CustomerWithAddressesWire } },
          description: "Customer with embedded addresses.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      const customerId = c.req.param("id");
      const customer = await service.getCustomerById(customerId);
      if (!customer) throw new NotFoundError("Customer not found.");
      const addresses = await service.listAddresses(customerId);
      return c.json(
        {
          ...toWireCustomer(customer),
          addresses: addresses.map((a) => toWireAddress(a)),
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/customers/{id}",
      tags: [TAG],
      summary: "Update a customer",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: updateCustomerSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: CustomerWire } },
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
      const customer = await service.updateCustomer(c.req.param("id"), patch);
      return c.json(toWireCustomer(customer), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/customers/{id}",
      tags: [TAG],
      summary: "Soft-delete a customer",
      request: { params: IdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Not found."),
      },
    }),
    async (c) => {
      await service.softDeleteCustomer(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------
  // Addresses
  // -------------------------------------------------------------------

  router.openapi(
    createRoute({
      method: "get",
      path: "/customers/{id}/addresses",
      tags: [TAG],
      summary: "List addresses for a customer",
      request: { params: IdParam },
      responses: {
        200: {
          content: { "application/json": { schema: AddressListEnvelope } },
          description: "Addresses.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Customer not found."),
      },
    }),
    async (c) => {
      const customerId = c.req.param("id");
      const customer = await service.getCustomerById(customerId);
      if (!customer) throw new NotFoundError("Customer not found.");
      const addresses = await service.listAddresses(customerId);
      return c.json({ data: addresses.map((a) => toWireAddress(a)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/customers/{id}/addresses",
      tags: [TAG],
      summary: "Create an address for a customer",
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: createAddressSchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: AddressWire } },
          description: "Created.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Customer not found."),
      },
    }),
    async (c) => {
      const customerId = c.req.param("id");
      const input = c.req.valid("json");
      const address = await service.createAddress(customerId, input);
      return c.json(toWireAddress(address), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/addresses/{addressId}",
      tags: [TAG],
      summary: "Update an address",
      request: {
        params: AddressIdParam,
        body: {
          content: { "application/json": { schema: updateAddressSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: AddressWire } },
          description: "Updated.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Address not found."),
      },
    }),
    async (c) => {
      const addressId = c.req.param("addressId");
      const patch = c.req.valid("json");
      // Resolve the owner from the row itself so the service's
      // (addressId, customerId) invariant holds without trusting a
      // request-supplied owner id.
      const existing = await service.getAddressById(addressId);
      if (!existing) throw new NotFoundError("Address not found.");
      const address = await service.updateAddress(
        addressId,
        existing.customerId,
        patch,
      );
      return c.json(toWireAddress(address), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/addresses/{addressId}",
      tags: [TAG],
      summary: "Delete an address",
      request: { params: AddressIdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("Address not found."),
      },
    }),
    async (c) => {
      const addressId = c.req.param("addressId");
      const existing = await service.getAddressById(addressId);
      if (!existing) throw new NotFoundError("Address not found.");
      await service.deleteAddress(addressId, existing.customerId);
      return c.body(null, 204);
    },
  );

  return router;
}

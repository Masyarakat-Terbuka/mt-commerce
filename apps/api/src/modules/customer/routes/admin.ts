/**
 * Admin customer routes — staff-facing CRUD over customers and their
 * addresses. Mounted at `/admin/v1` from the top-level router.
 *
 * TODO requireRole("owner", "admin", "staff"):
 *   The auth module (`requireAuth` + `requireRole`) lands in a parallel
 *   track and is not imported here yet to avoid coupling the customer
 *   module to a still-merging surface. Once both tracks are reconciled,
 *   uncomment the gate at the top of `buildCustomerAdminRoutes` (the same
 *   pattern catalog/admin.ts uses).
 *
 * Conventions:
 *   - Bodies are validated through Zod schemas from `types.ts`.
 *   - Validation failures throw `ValidationError` so the standard error
 *     handler renders the consistent `{ error: { code, message, details } }`
 *     envelope.
 *   - Domain types are converted to wire shapes by helpers in `wire.ts`.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
import type { CustomerService } from "../service.js";
import {
  createAddressSchema,
  createCustomerSchema,
  listCustomersQuerySchema,
  updateAddressSchema,
  updateCustomerSchema,
} from "../types.js";
import { toWireAddress, toWireCustomer } from "./wire.js";

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

export function buildCustomerAdminRoutes(
  service: CustomerService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // TODO requireAuth() + requireRole("owner", "admin", "staff") — see file
  // header. Wired in once the auth module is reconciled into this branch.
  // router.use("*", requireAuth());
  // router.use("*", requireRole("owner", "admin", "staff"));

  // -------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------

  router.get("/customers", async (c) => {
    const query = parseOrThrow(
      listCustomersQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const result = await service.listCustomers({
      ...query,
      excludeDeleted: true,
    });
    return c.json({
      data: result.data.map((cust) => toWireCustomer(cust)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.post("/customers", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createCustomerSchema, raw);
    const customer = await service.createCustomer(input);
    return c.json(toWireCustomer(customer), 201);
  });

  router.get("/customers/:id", async (c) => {
    const customerId = c.req.param("id");
    const customer = await service.getCustomerById(customerId);
    if (!customer) throw new NotFoundError("Customer not found.");
    const addresses = await service.listAddresses(customerId);
    return c.json({
      ...toWireCustomer(customer),
      addresses: addresses.map((a) => toWireAddress(a)),
    });
  });

  router.patch("/customers/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateCustomerSchema, raw);
    const customer = await service.updateCustomer(c.req.param("id"), patch);
    return c.json(toWireCustomer(customer));
  });

  router.delete("/customers/:id", async (c) => {
    await service.softDeleteCustomer(c.req.param("id"));
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------
  // Addresses
  // -------------------------------------------------------------------

  router.get("/customers/:id/addresses", async (c) => {
    const customerId = c.req.param("id");
    const customer = await service.getCustomerById(customerId);
    if (!customer) throw new NotFoundError("Customer not found.");
    const addresses = await service.listAddresses(customerId);
    return c.json({ data: addresses.map((a) => toWireAddress(a)) });
  });

  router.post("/customers/:id/addresses", async (c) => {
    const customerId = c.req.param("id");
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createAddressSchema, raw);
    const address = await service.createAddress(customerId, input);
    return c.json(toWireAddress(address), 201);
  });

  router.patch("/addresses/:addressId", async (c) => {
    const addressId = c.req.param("addressId");
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateAddressSchema, raw);
    // Admin path: resolve owner from the row itself so the service can still
    // enforce its (addressId, customerId) invariant without trusting a
    // request-supplied owner id.
    const existing = await service.getAddressById(addressId);
    if (!existing) throw new NotFoundError("Address not found.");
    const address = await service.updateAddress(
      addressId,
      existing.customerId,
      patch,
    );
    return c.json(toWireAddress(address));
  });

  router.delete("/addresses/:addressId", async (c) => {
    const addressId = c.req.param("addressId");
    const existing = await service.getAddressById(addressId);
    if (!existing) throw new NotFoundError("Address not found.");
    await service.deleteAddress(addressId, existing.customerId);
    return c.body(null, 204);
  });

  return router;
}

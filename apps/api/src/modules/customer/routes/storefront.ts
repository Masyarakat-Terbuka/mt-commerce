/**
 * Storefront customer routes — `/me` endpoints for the authenticated buyer
 * and public region/postal-code lookups for address autofill. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Auth — TWO categories:
 *
 *   1. `/customer/me/*` requires an authenticated customer. The auth
 *      middleware populates `c.var.authUser`; this module resolves the
 *      domain `Customer` row via `getCustomerByAuthUserId`. A request whose
 *      auth_user has no corresponding customer row gets a 404 with the
 *      `customer_not_provisioned` code so the storefront can prompt the
 *      buyer to complete their profile.
 *
 *   2. `/regions/*` is public (anyone building a checkout autofill needs
 *      these without an account). No auth gate now or later.
 *
 * OpenAPI: every route is declared via `createRoute`/`router.openapi(...)`
 * so it surfaces in `/openapi.json`. Bodies and queries are validated through
 * the same Zod schemas exported from `types.ts`; failures throw `ZodError`.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import type { Context } from "hono";
import { getAuthedUser, requireAuth } from "../../auth/index.js";
import type { Customer } from "../types.js";
import type { CustomerService } from "../service.js";
import {
  createAddressSchema,
  listKecamatanQuerySchema,
  listKelurahanQuerySchema,
  listKotaKabupatenQuerySchema,
  setDefaultAddressSchema,
  updateAddressSchema,
  updateCustomerSchema,
} from "../types.js";
import {
  toWireAddress,
  toWireCity,
  toWireCustomer,
  toWireDistrict,
  toWireProvince,
  toWireSubdistrict,
} from "./wire.js";
import {
  AddressListEnvelope,
  AddressWire,
  CityListEnvelope,
  CustomerWire,
  DistrictListEnvelope,
  ProvinceListEnvelope,
  SubdistrictListEnvelope,
} from "./openapi-schemas.js";

const TAG = "customer (storefront)";

const IdParam = z.object({ id: z.string().min(1) });
const PostalCodeParam = z.object({
  code: z
    .string()
    .regex(/^\d{5}$/, "postal code must be a 5-digit numeric string."),
});

/**
 * Resolve the `Customer` row for the authenticated request. Assumes
 * `requireAuth()` has already run (so `c.var.authUser` is populated).
 *
 * A signed-in `auth_user` without a matching `customers.auth_user_id`
 * row is a v0.1 edge case: a Better Auth account can exist before the
 * customer profile is provisioned (sign-up flow that hasn't completed,
 * a staff user trying to use the storefront). We surface a 404 with a
 * stable code so the storefront can render a "complete your profile"
 * prompt rather than a generic error.
 */
async function resolveCurrentCustomer(
  c: Context<AppBindings>,
  service: CustomerService,
): Promise<Customer> {
  const user = getAuthedUser(c);
  const customer = await service.getCustomerByAuthUserId(user.id);
  if (!customer) {
    throw new NotFoundError("Customer profile not found.", {
      code: "customer_not_provisioned",
      authUserId: user.id,
    });
  }
  return customer;
}

export function buildCustomerStorefrontRoutes(
  service: CustomerService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  // -------------------------------------------------------------------
  // /customer/me — requires an authenticated customer
  // -------------------------------------------------------------------

  router.use("/customer/me", requireAuth());
  router.use("/customer/me/*", requireAuth());

  router.openapi(
    createRoute({
      method: "get",
      path: "/customer/me",
      tags: [TAG],
      summary: "Get the current customer",
      description:
        "Returns the authenticated customer's profile. The customer is resolved from the session cookie's auth_user via `customers.auth_user_id`.",
      responses: {
        200: {
          content: { "application/json": { schema: CustomerWire } },
          description: "Customer.",
        },
        401: errorResponse("Authentication required."),
        404: errorResponse("Customer profile not provisioned for this user."),
      },
    }),
    async (c) => {
      const customer = await resolveCurrentCustomer(c, service);
      return c.json(toWireCustomer(customer), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/customer/me",
      tags: [TAG],
      summary: "Update the current customer",
      request: {
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
        404: errorResponse("Customer not found."),
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const patch = c.req.valid("json");
      const customer = await service.updateCustomer(current.id, patch);
      return c.json(toWireCustomer(customer), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/customer/me/addresses",
      tags: [TAG],
      summary: "List the current customer's addresses",
      responses: {
        200: {
          content: { "application/json": { schema: AddressListEnvelope } },
          description: "Addresses.",
        },
        401: errorResponse("Authentication required."),
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const addresses = await service.listAddresses(current.id);
      return c.json({ data: addresses.map((a) => toWireAddress(a)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/customer/me/addresses",
      tags: [TAG],
      summary: "Create an address",
      request: {
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
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const input = c.req.valid("json");
      const address = await service.createAddress(current.id, input);
      return c.json(toWireAddress(address), 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/customer/me/addresses/{id}",
      tags: [TAG],
      summary: "Update one of the current customer's addresses",
      request: {
        params: IdParam,
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
        404: errorResponse("Address not found."),
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const addressId = c.req.param("id");
      const patch = c.req.valid("json");
      const address = await service.updateAddress(addressId, current.id, patch);
      return c.json(toWireAddress(address), 200);
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/customer/me/addresses/{id}",
      tags: [TAG],
      summary: "Delete one of the current customer's addresses",
      request: { params: IdParam },
      responses: {
        204: { description: "Deleted." },
        401: errorResponse("Authentication required."),
        404: errorResponse("Address not found."),
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const addressId = c.req.param("id");
      await service.deleteAddress(addressId, current.id);
      return c.body(null, 204);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/customer/me/addresses/{id}/default",
      tags: [TAG],
      summary: "Mark an address as default for a kind",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: setDefaultAddressSchema },
          },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: AddressWire } },
          description: "Updated address.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        404: errorResponse("Address not found."),
      },
    }),
    async (c) => {
      const current = await resolveCurrentCustomer(c, service);
      const addressId = c.req.param("id");
      const { kind } = c.req.valid("json");
      const address = await service.setDefaultAddress(
        current.id,
        addressId,
        kind,
      );
      return c.json(toWireAddress(address), 200);
    },
  );

  // -------------------------------------------------------------------
  // /regions — public (no auth gate)
  //
  // Region data is platform-managed reference data sourced from BPS imports
  // and changes on the order of months. The Cache-Control middleware below
  // tags successful responses for shared caches; `/regions/*` reads are
  // safe to memoize for a day.
  // -------------------------------------------------------------------

  const REGIONS_CACHE_HEADER = "public, max-age=86400";

  router.use("/regions/*", async (c, next) => {
    await next();
    if (c.res.status >= 200 && c.res.status < 300) {
      c.header("Cache-Control", REGIONS_CACHE_HEADER);
    }
  });

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions/provinsi",
      tags: [TAG],
      summary: "List provinces (public)",
      responses: {
        200: {
          content: { "application/json": { schema: ProvinceListEnvelope } },
          description: "Provinces.",
        },
      },
    }),
    async (c) => {
      const provinces = await service.listProvinsi();
      return c.json({ data: provinces.map((p) => toWireProvince(p)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions/kota-kabupaten",
      tags: [TAG],
      summary: "List cities/regencies under a province (public)",
      request: { query: listKotaKabupatenQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: CityListEnvelope } },
          description: "Cities.",
        },
        400: errorResponse("Invalid query."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const cities = await service.listKotaKabupaten(query);
      return c.json({ data: cities.map((city) => toWireCity(city)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions/kecamatan",
      tags: [TAG],
      summary: "List districts under a city/regency (public)",
      request: { query: listKecamatanQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: DistrictListEnvelope } },
          description: "Districts.",
        },
        400: errorResponse("Invalid query."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const districts = await service.listKecamatan(query);
      return c.json({ data: districts.map((d) => toWireDistrict(d)) }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions/kelurahan",
      tags: [TAG],
      summary: "List subdistricts under a district (public)",
      request: { query: listKelurahanQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: SubdistrictListEnvelope } },
          description: "Subdistricts.",
        },
        400: errorResponse("Invalid query."),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const subdistricts = await service.listKelurahan(query);
      return c.json(
        { data: subdistricts.map((s) => toWireSubdistrict(s)) },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions/postal-code/{code}",
      tags: [TAG],
      summary: "Look up subdistricts by postal code (public)",
      description:
        "Multiple kelurahans can share a postal code; the response is a list.",
      request: { params: PostalCodeParam },
      responses: {
        200: {
          content: { "application/json": { schema: SubdistrictListEnvelope } },
          description: "Matching subdistricts.",
        },
        400: errorResponse("Invalid postal code."),
      },
    }),
    async (c) => {
      const code = c.req.valid("param").code;
      const subdistricts = await service.searchPostalCode(code);
      return c.json(
        { data: subdistricts.map((s) => toWireSubdistrict(s)) },
        200,
      );
    },
  );

  return router;
}

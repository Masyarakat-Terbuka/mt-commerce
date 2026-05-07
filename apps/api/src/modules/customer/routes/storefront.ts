/**
 * Storefront customer routes — `/me` endpoints for the authenticated buyer
 * and public region/postal-code lookups for address autofill. Mounted at
 * `/storefront/v1` from the top-level router.
 *
 * Auth — TWO categories:
 *
 *   1. `/customer/me/*` requires an authenticated customer.
 *      TODO requireAuth(): the auth module will populate `c.var.authUser`,
 *      from which we will resolve the customer via `getCustomerByAuthUserId`.
 *      Until that lands, these routes accept a stand-in `x-customer-id`
 *      header (development-only). Production builds MUST replace this with
 *      the auth-derived resolution.
 *
 *   2. `/regions/*` is public (anyone building a checkout autofill needs
 *      these without an account). No auth gate now or later.
 *
 * Conventions match the admin router: Zod-validated bodies, ValidationError
 * for parse failures, wire helpers for JSON shaping.
 */
import { Hono, type Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AppBindings } from "../../../lib/types.js";
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

/**
 * TEMPORARY: resolve the current customer from the `x-customer-id` request
 * header. Replaced by `c.var.authUser`-driven lookup once the auth module is
 * wired. Throws 401 when the header is missing so the contract matches the
 * eventual auth-gated behavior — clients that work today will continue to
 * work tomorrow with only their auth setup changing.
 */
async function resolveCurrentCustomerId(
  c: Context<AppBindings>,
): Promise<string> {
  const headerId = c.req.header("x-customer-id");
  if (!headerId) {
    throw new UnauthorizedError(
      "Missing customer context. (Stand-in `x-customer-id` header expected until auth lands.)",
    );
  }
  return headerId;
}

export function buildCustomerStorefrontRoutes(
  service: CustomerService,
): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // -------------------------------------------------------------------
  // /customer/me — TODO requireAuth()
  // -------------------------------------------------------------------

  router.get("/customer/me", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const customer = await service.getCustomerById(customerId);
    if (!customer) throw new NotFoundError("Customer not found.");
    return c.json(toWireCustomer(customer));
  });

  router.patch("/customer/me", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateCustomerSchema, raw);
    const customer = await service.updateCustomer(customerId, patch);
    return c.json(toWireCustomer(customer));
  });

  router.get("/customer/me/addresses", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const addresses = await service.listAddresses(customerId);
    return c.json({ data: addresses.map((a) => toWireAddress(a)) });
  });

  router.post("/customer/me/addresses", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const raw = await readJsonBody(c.req.raw);
    const input = parseOrThrow(createAddressSchema, raw);
    const address = await service.createAddress(customerId, input);
    return c.json(toWireAddress(address), 201);
  });

  router.patch("/customer/me/addresses/:id", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const addressId = c.req.param("id");
    const raw = await readJsonBody(c.req.raw);
    const patch = parseOrThrow(updateAddressSchema, raw);
    const address = await service.updateAddress(addressId, customerId, patch);
    return c.json(toWireAddress(address));
  });

  router.delete("/customer/me/addresses/:id", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const addressId = c.req.param("id");
    await service.deleteAddress(addressId, customerId);
    return c.body(null, 204);
  });

  router.put("/customer/me/addresses/:id/default", async (c) => {
    const customerId = await resolveCurrentCustomerId(c);
    const addressId = c.req.param("id");
    const raw = await readJsonBody(c.req.raw);
    const { kind } = parseOrThrow(setDefaultAddressSchema, raw);
    const address = await service.setDefaultAddress(
      customerId,
      addressId,
      kind,
    );
    return c.json(toWireAddress(address));
  });

  // -------------------------------------------------------------------
  // /regions — public (no auth gate, now or later)
  //
  // Region data is platform-managed reference data sourced from BPS
  // imports — it changes on the order of months. Without a Cache-Control
  // hint, every storefront page render and every checkout autofill spins
  // up a fresh round-trip; with `public, max-age=86400` browsers and
  // shared caches (CDN, reverse proxies) will serve repeats locally for
  // a day. If we ever push a partial BPS update, bump the deploy and the
  // cached entries age out within 24h. The middleware below applies the
  // header to every `/regions/*` GET before the handler runs.
  // -------------------------------------------------------------------

  const REGIONS_CACHE_HEADER = "public, max-age=86400";

  router.use("/regions/*", async (c, next) => {
    await next();
    // Only set the header on success — for 4xx (e.g. invalid postal code)
    // we do not want shared caches to memoize the error.
    if (c.res.status >= 200 && c.res.status < 300) {
      c.header("Cache-Control", REGIONS_CACHE_HEADER);
    }
  });

  router.get("/regions/provinsi", async (c) => {
    const provinces = await service.listProvinsi();
    return c.json({ data: provinces.map((p) => toWireProvince(p)) });
  });

  router.get("/regions/kota-kabupaten", async (c) => {
    const query = parseOrThrow(
      listKotaKabupatenQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const cities = await service.listKotaKabupaten(query);
    return c.json({ data: cities.map((city) => toWireCity(city)) });
  });

  router.get("/regions/kecamatan", async (c) => {
    const query = parseOrThrow(
      listKecamatanQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const districts = await service.listKecamatan(query);
    return c.json({ data: districts.map((d) => toWireDistrict(d)) });
  });

  router.get("/regions/kelurahan", async (c) => {
    const query = parseOrThrow(
      listKelurahanQuerySchema,
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const subdistricts = await service.listKelurahan(query);
    return c.json({ data: subdistricts.map((s) => toWireSubdistrict(s)) });
  });

  router.get("/regions/postal-code/:code", async (c) => {
    const code = c.req.param("code");
    if (!/^\d{5}$/.test(code)) {
      throw new ValidationError("postal code must be a 5-digit numeric string.", {
        code: "invalid_postal_code",
        value: code,
      });
    }
    const subdistricts = await service.searchPostalCode(code);
    // Multiple kelurahans can share a postal code — return the full list.
    return c.json({ data: subdistricts.map((s) => toWireSubdistrict(s)) });
  });

  return router;
}

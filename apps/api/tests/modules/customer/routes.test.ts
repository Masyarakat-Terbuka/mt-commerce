/**
 * Customer routes — auth/role enforcement smoke tests.
 *
 * The QA reviewer flagged that the admin customer router was mounted
 * without a `requireAuth` + `requireRole` gate, exposing every customer's
 * PII to anonymous callers. These tests pin the gates so a future
 * refactor that drops them fails loudly:
 *
 *   - Anonymous request → 401 with the standard envelope.
 *   - Viewer-role request → 403.
 *   - Staff/admin/owner → 200 (the route runs).
 *
 * The same fake-AuthService injection pattern as catalog/routes.test.ts:
 * `vi.spyOn` the singleton's `verifyApiKey`/`getStaffProfile` so the
 * real Better Auth handler never runs, and we can hand-craft the
 * authenticated identity per test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import { authService } from "../../../src/modules/auth/index.js";
import { buildCustomerAdminRoutes } from "../../../src/modules/customer/routes/admin.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type {
  Customer,
  CustomerAddress,
  CustomerService,
  Paginated,
} from "../../../src/modules/customer/index.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

const STAFF_USER = {
  id: "usr_staff",
  email: "staff@example.com",
  emailVerified: true,
  name: "Staff",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VIEWER_USER = {
  id: "usr_viewer",
  email: "viewer@example.com",
  emailVerified: true,
  name: "Viewer",
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.spyOn(authService, "verifyApiKey").mockImplementation(async (bearer) => {
    if (bearer === "staff-key") {
      return {
        apiKey: {
          id: "apik_staff",
          userId: STAFF_USER.id,
          name: "test",
          scopes: ["catalog:read"],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: STAFF_USER,
      };
    }
    if (bearer === "viewer-key") {
      return {
        apiKey: {
          id: "apik_viewer",
          userId: VIEWER_USER.id,
          name: "test",
          scopes: ["catalog:read"],
          lastUsedAt: null,
          createdAt: NOW,
          revokedAt: null,
        },
        user: VIEWER_USER,
      };
    }
    return null;
  });
  vi.spyOn(authService, "getStaffProfile").mockImplementation(async (id) => {
    if (id === STAFF_USER.id) {
      return {
        authUserId: STAFF_USER.id,
        role: "admin",
        displayName: "Staff",
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
    if (id === VIEWER_USER.id) {
      return {
        authUserId: VIEWER_USER.id,
        role: "viewer",
        displayName: "Viewer",
        createdAt: NOW,
        updatedAt: NOW,
      };
    }
    return null;
  });
});

function fakeCustomerService(): CustomerService {
  const fail = (): never => {
    throw new Error("not implemented in this test");
  };
  return {
    async createCustomer(): Promise<Customer> {
      return fail();
    },
    async getCustomerById() {
      return null;
    },
    async getCustomerByAuthUserId() {
      return null;
    },
    async getCustomerByEmail() {
      return null;
    },
    async listCustomers(): Promise<Paginated<Customer>> {
      return { data: [], total: 0, page: 1, pageSize: 20 };
    },
    async updateCustomer(): Promise<Customer> {
      return fail();
    },
    async softDeleteCustomer() {
      return;
    },
    async getAddressById() {
      return null;
    },
    async listAddresses() {
      return [];
    },
    async createAddress(): Promise<CustomerAddress> {
      return fail();
    },
    async updateAddress(): Promise<CustomerAddress> {
      return fail();
    },
    async deleteAddress() {
      return;
    },
    async setDefaultAddress(): Promise<CustomerAddress> {
      return fail();
    },
    async listProvinsi() {
      return [];
    },
    async listKotaKabupaten() {
      return [];
    },
    async listKecamatan() {
      return [];
    },
    async listKelurahan() {
      return [];
    },
    async searchPostalCode() {
      return [];
    },
  };
}

function buildAdminApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1", buildCustomerAdminRoutes(fakeCustomerService()));
  app.onError(errorHandler);
  return app;
}

describe("customer admin routes — auth gate", () => {
  it("rejects anonymous /admin/v1/customers with 401 + standard envelope", async () => {
    const app = buildAdminApp();
    const res = await app.request("/admin/v1/customers");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a viewer-role caller with 403 (PII protection)", async () => {
    const app = buildAdminApp();
    const res = await app.request("/admin/v1/customers", {
      headers: { authorization: "Bearer viewer-key" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("admits an admin caller (200)", async () => {
    const app = buildAdminApp();
    const res = await app.request("/admin/v1/customers", {
      headers: { authorization: "Bearer staff-key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(0);
    expect(body.data).toEqual([]);
  });
});

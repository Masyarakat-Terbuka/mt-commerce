/**
 * Auth routes — focused integration tests using Hono's `app.request()`.
 *
 * The Better Auth framework itself is exercised end-to-end in a follow-up
 * integration suite that runs against a real Postgres. These unit-style
 * tests focus on the routes mt-commerce *adds* on top of Better Auth:
 *   - `requireAuth()` rejecting anonymous requests
 *   - `requireRole(...)` rejecting wrong-role users
 *   - The standard error envelope on auth failures
 *
 * We swap in a fake `AuthService` so we never need a database.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../../../src/middleware/error-handler.js";
import { buildAuthAdminRoutes } from "../../../../src/modules/auth/routes/admin.js";
import { buildAuthStorefrontRoutes } from "../../../../src/modules/auth/routes/storefront.js";
import type { AuthService } from "../../../../src/modules/auth/service.js";
import type { AppBindings } from "../../../../src/lib/types.js";
import type {
  ApiKey,
  AuthSession,
  AuthUser,
  Role,
  StaffProfile,
} from "../../../../src/modules/auth/types.js";

const NOW = new Date("2026-05-07T12:00:00.000Z");

function makeService(opts: {
  user?: AuthUser;
  staff?: StaffProfile;
  validBearer?: { bearer: string; user: AuthUser; apiKey: ApiKey };
}): AuthService {
  return {
    async getStaffProfile(id) {
      if (opts.staff && opts.staff.authUserId === id) return opts.staff;
      return null;
    },
    async assignRole(input) {
      const profile: StaffProfile = {
        authUserId: input.authUserId,
        role: input.role,
        displayName: input.displayName,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return profile;
    },
    async listSessions(userId) {
      const session: AuthSession = {
        id: "sess_a",
        userId,
        expiresAt: new Date(NOW.getTime() + 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: NOW,
      };
      return [session];
    },
    async revokeSession() {
      return;
    },
    async revokeAllSessions() {
      return;
    },
    async createApiKey(input) {
      const apiKey: ApiKey = {
        id: "apik_new",
        userId: input.userId,
        name: input.name,
        scopes: input.scopes,
        lastUsedAt: null,
        createdAt: NOW,
        revokedAt: null,
      };
      return { apiKey, plaintext: "apik_new.SECRET" };
    },
    async listApiKeys(userId) {
      const apiKey: ApiKey = {
        id: "apik_existing",
        userId,
        name: "Existing",
        scopes: ["catalog:read"],
        lastUsedAt: null,
        createdAt: NOW,
        revokedAt: null,
      };
      return [apiKey];
    },
    async revokeApiKey() {
      return;
    },
    async verifyApiKey(bearer) {
      if (opts.validBearer && bearer === opts.validBearer.bearer) {
        return {
          apiKey: opts.validBearer.apiKey,
          user: opts.validBearer.user,
        };
      }
      return null;
    },
  };
}

function buildAdminApp(service: AuthService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/admin/v1/auth", buildAuthAdminRoutes(service));
  app.onError(errorHandler);
  return app;
}

function buildStorefrontApp(service: AuthService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/storefront/v1/auth", buildAuthStorefrontRoutes(service));
  app.onError(errorHandler);
  return app;
}

describe("admin /admin/v1/auth", () => {
  it("rejects unauthenticated /me with 401 + standard envelope", async () => {
    const service = makeService({});
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/auth/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns the staff profile for an authenticated owner", async () => {
    const user: AuthUser = {
      id: "usr_owner",
      email: "owner@example.com",
      emailVerified: true,
      name: "Owner",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const staff: StaffProfile = {
      authUserId: user.id,
      role: "owner",
      displayName: "Owner",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const apiKey: ApiKey = {
      id: "apik_test",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: NOW,
      revokedAt: null,
    };
    const service = makeService({
      user,
      staff,
      validBearer: { bearer: "apik_test.SECRET", user, apiKey },
    });
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/auth/me", {
      headers: { authorization: "Bearer apik_test.SECRET" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string };
      staff: { role: Role } | null;
    };
    expect(body.user.id).toBe("usr_owner");
    expect(body.staff?.role).toBe("owner");
  });

  it("rejects POST /staff for a non-owner staff with 403", async () => {
    const user: AuthUser = {
      id: "usr_admin",
      email: "admin@example.com",
      emailVerified: true,
      name: "Admin",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const staff: StaffProfile = {
      authUserId: user.id,
      role: "admin",
      displayName: "Admin",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const apiKey: ApiKey = {
      id: "apik_admin",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: NOW,
      revokedAt: null,
    };
    const service = makeService({
      user,
      staff,
      validBearer: { bearer: "apik_admin.SECRET", user, apiKey },
    });
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/auth/staff", {
      method: "POST",
      headers: {
        authorization: "Bearer apik_admin.SECRET",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        authUserId: "usr_x",
        role: "admin",
        displayName: "X",
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("validation error renders the standard envelope on bad input", async () => {
    const user: AuthUser = {
      id: "usr_owner",
      email: "owner@example.com",
      emailVerified: true,
      name: "Owner",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const staff: StaffProfile = {
      authUserId: user.id,
      role: "owner",
      displayName: "Owner",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const apiKey: ApiKey = {
      id: "apik_owner",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: NOW,
      revokedAt: null,
    };
    const service = makeService({
      user,
      staff,
      validBearer: { bearer: "apik_owner.SECRET", user, apiKey },
    });
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/auth/staff", {
      method: "POST",
      headers: {
        authorization: "Bearer apik_owner.SECRET",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("creates an API key and returns the plaintext in the response", async () => {
    const user: AuthUser = {
      id: "usr_owner",
      email: "owner@example.com",
      emailVerified: true,
      name: "Owner",
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const staff: StaffProfile = {
      authUserId: user.id,
      role: "owner",
      displayName: "Owner",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const apiKey: ApiKey = {
      id: "apik_owner",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: NOW,
      revokedAt: null,
    };
    const service = makeService({
      user,
      staff,
      validBearer: { bearer: "apik_owner.SECRET", user, apiKey },
    });
    const app = buildAdminApp(service);
    const res = await app.request("/admin/v1/auth/api-keys", {
      method: "POST",
      headers: {
        authorization: "Bearer apik_owner.SECRET",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Webhook receiver",
        scopes: ["webhooks:receive"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      plaintext: string;
      scopes: string[];
    };
    expect(body.plaintext).toBe("apik_new.SECRET");
    expect(body.scopes).toEqual(["webhooks:receive"]);
  });
});

describe("storefront /storefront/v1/auth", () => {
  it("returns { user: null } when there is no auth", async () => {
    const service = makeService({});
    const app = buildStorefrontApp(service);
    const res = await app.request("/storefront/v1/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });
});

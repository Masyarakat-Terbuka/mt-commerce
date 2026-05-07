/**
 * Auth middleware — unit tests over a tiny Hono app using
 * `app.request(...)`. The auth service is faked in-line so we never touch
 * Better Auth in unit tests; the real Better Auth handler gets exercised in
 * the route-level integration tests instead.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildRequireAuth,
  buildRequireRole,
  buildRequireScope,
} from "../../../src/modules/auth/middleware.js";
import { errorHandler } from "../../../src/middleware/error-handler.js";
import type { AppBindings } from "../../../src/lib/types.js";
import type { AuthService } from "../../../src/modules/auth/service.js";
import type {
  ApiKey,
  AuthSession,
  AuthUser,
  Role,
  Scope,
  StaffProfile,
} from "../../../src/modules/auth/types.js";

const FIXED_NOW = new Date("2026-05-07T12:00:00.000Z");

interface ServiceFixture {
  user: AuthUser | null;
  staffByUser: Map<string, StaffProfile>;
  apiKeys: Map<string, { apiKey: ApiKey; user: AuthUser }>;
}

function makeUser(id: string): AuthUser {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: id,
    image: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

function makeService(fix: ServiceFixture): AuthService {
  return {
    async getStaffProfile(authUserId) {
      return fix.staffByUser.get(authUserId) ?? null;
    },
    async assignRole() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async revokeSession() {
      return;
    },
    async revokeAllSessions() {
      return;
    },
    async createApiKey() {
      throw new Error("not used");
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      return;
    },
    async verifyApiKey(bearer) {
      return fix.apiKeys.get(bearer) ?? null;
    },
  };
}

// We can't easily inject a fake Better Auth without spinning up a real
// instance. The middleware path that we test below uses ONLY API keys —
// the session path is covered separately in the route integration tests
// (which exercise the real Better Auth handler).

function buildApp(service: AuthService): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const requireAuth = buildRequireAuth(service);
  const requireRole = buildRequireRole(service);
  const requireScope = buildRequireScope();

  app.get("/auth-required", requireAuth(), (c) => {
    return c.json({ user: c.get("authUser")?.id ?? null });
  });

  app.get("/auth-optional", requireAuth({ required: false }), (c) => {
    return c.json({ user: c.get("authUser")?.id ?? null });
  });

  app.get(
    "/staff-only",
    requireAuth(),
    requireRole("owner", "admin", "staff"),
    (c) => c.json({ ok: true }),
  );

  app.get(
    "/owner-only",
    requireAuth(),
    requireRole("owner"),
    (c) => c.json({ ok: true }),
  );

  app.get(
    "/needs-write",
    requireAuth(),
    requireScope("catalog:write"),
    (c) => c.json({ ok: true }),
  );

  app.onError(errorHandler);
  return app;
}

describe("requireAuth", () => {
  it("returns 401 with the standard envelope when no auth is present", async () => {
    const fix: ServiceFixture = {
      user: null,
      staffByUser: new Map(),
      apiKeys: new Map(),
    };
    const app = buildApp(makeService(fix));
    const res = await app.request("/auth-required");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("passes through when the bearer is a valid API key", async () => {
    const user = makeUser("usr_1");
    const apiKey: ApiKey = {
      id: "apik_1",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: FIXED_NOW,
      revokedAt: null,
    };
    const fix: ServiceFixture = {
      user,
      staffByUser: new Map(),
      apiKeys: new Map([["apik_1.SECRET", { apiKey, user }]]),
    };
    const app = buildApp(makeService(fix));
    const res = await app.request("/auth-required", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string };
    expect(body.user).toBe("usr_1");
  });

  it("returns 401 for a malformed/invalid bearer even when required is false", async () => {
    // A wrong bearer is intent — never silently fall through.
    const fix: ServiceFixture = {
      user: null,
      staffByUser: new Map(),
      apiKeys: new Map(),
    };
    const app = buildApp(makeService(fix));
    const res = await app.request("/auth-optional", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("optional + no auth returns 200 with null user", async () => {
    const fix: ServiceFixture = {
      user: null,
      staffByUser: new Map(),
      apiKeys: new Map(),
    };
    const app = buildApp(makeService(fix));
    const res = await app.request("/auth-optional");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string | null };
    expect(body.user).toBeNull();
  });
});

describe("requireRole", () => {
  function appWithStaff(role: Role): Hono<AppBindings> {
    const user = makeUser("usr_1");
    const staff: StaffProfile = {
      authUserId: user.id,
      role,
      displayName: "Test",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const apiKey: ApiKey = {
      id: "apik_1",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: FIXED_NOW,
      revokedAt: null,
    };
    const fix: ServiceFixture = {
      user,
      staffByUser: new Map([[user.id, staff]]),
      apiKeys: new Map([["apik_1.SECRET", { apiKey, user }]]),
    };
    return buildApp(makeService(fix));
  }

  it("rejects with 403 when the role is not in the accepted set", async () => {
    const app = appWithStaff("viewer");
    const res = await app.request("/staff-only", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects with 403 when there is no staff profile at all", async () => {
    const user = makeUser("usr_only_customer");
    const apiKey: ApiKey = {
      id: "apik_2",
      userId: user.id,
      name: "test",
      scopes: ["catalog:read"],
      lastUsedAt: null,
      createdAt: FIXED_NOW,
      revokedAt: null,
    };
    const fix: ServiceFixture = {
      user,
      staffByUser: new Map(), // no staff profile
      apiKeys: new Map([["apik_2.SECRET", { apiKey, user }]]),
    };
    const app = buildApp(makeService(fix));
    const res = await app.request("/staff-only", {
      headers: { authorization: "Bearer apik_2.SECRET" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts when role is in the set", async () => {
    const app = appWithStaff("admin");
    const res = await app.request("/staff-only", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(200);
  });

  it("owner-only rejects an admin", async () => {
    const app = appWithStaff("admin");
    const res = await app.request("/owner-only", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(403);
  });
});

describe("requireScope", () => {
  function appWithKeyScopes(scopes: Scope[]): Hono<AppBindings> {
    const user = makeUser("usr_1");
    const apiKey: ApiKey = {
      id: "apik_1",
      userId: user.id,
      name: "test",
      scopes,
      lastUsedAt: null,
      createdAt: FIXED_NOW,
      revokedAt: null,
    };
    const fix: ServiceFixture = {
      user,
      staffByUser: new Map(),
      apiKeys: new Map([["apik_1.SECRET", { apiKey, user }]]),
    };
    return buildApp(makeService(fix));
  }

  it("rejects with 403 when the scope is missing", async () => {
    const app = appWithKeyScopes(["catalog:read"]);
    const res = await app.request("/needs-write", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("accepts when the scope is present", async () => {
    const app = appWithKeyScopes(["catalog:read", "catalog:write"]);
    const res = await app.request("/needs-write", {
      headers: { authorization: "Bearer apik_1.SECRET" },
    });
    expect(res.status).toBe(200);
  });
});

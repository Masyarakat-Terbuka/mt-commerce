/**
 * Admin auth routes — staff-only auth-side operations beyond what Better
 * Auth's own handler exposes.
 *
 * Better Auth itself owns:
 *   POST /api/auth/sign-up/email
 *   POST /api/auth/sign-in/email
 *   POST /api/auth/sign-out
 *   POST /api/auth/forget-password
 *   POST /api/auth/reset-password
 *   POST /api/auth/verify-email
 *   GET  /api/auth/get-session
 *
 * This router covers what staff need on top of those:
 *   - GET    /admin/v1/auth/me                — the staff profile of the caller
 *   - GET    /admin/v1/auth/sessions          — list active sessions
 *   - DELETE /admin/v1/auth/sessions/:id      — revoke a session
 *   - POST   /admin/v1/auth/staff             — create/update a staff profile (owner-only)
 *   - GET    /admin/v1/auth/api-keys          — list the caller's API keys
 *   - POST   /admin/v1/auth/api-keys          — issue a new API key
 *   - DELETE /admin/v1/auth/api-keys/:id      — revoke an API key
 *
 * Every route requires session auth; the role gates layer on top.
 */
import { Hono } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  ForbiddenError,
  ValidationError,
  issuesToDetails,
} from "../../../lib/errors.js";
import type { AuthAppBindings } from "../middleware.js";
import {
  assignRoleSchema,
  createApiKeySchema,
} from "../types.js";
import type { AuthService } from "../service.js";
import {
  buildRequireAuth,
  buildRequireRole,
  getAuthedUser,
} from "../middleware.js";

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

export function buildAuthAdminRoutes(
  service: AuthService,
): Hono<AuthAppBindings> {
  const router = new Hono<AuthAppBindings>();
  const requireAuth = buildRequireAuth(service);
  const requireRole = buildRequireRole(service);

  // Every admin route in this module is staff-only. Apply session auth and
  // a baseline role gate up front; specific endpoints can tighten further.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff", "viewer"));

  // ---------------------------------------------------------------
  // /me — the caller's staff profile + auth user info
  // ---------------------------------------------------------------
  router.get("/me", async (c) => {
    const user = getAuthedUser(c);
    const profile = c.get("staffProfile");
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        image: user.image,
      },
      staff: profile
        ? {
            authUserId: profile.authUserId,
            role: profile.role,
            displayName: profile.displayName,
          }
        : null,
    });
  });

  // ---------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------
  router.get("/sessions", async (c) => {
    const user = getAuthedUser(c);
    const sessions = await service.listSessions(user.id);
    return c.json({
      data: sessions.map((s) => ({
        id: s.id,
        expiresAt: s.expiresAt.toISOString(),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
      })),
    });
  });

  router.delete("/sessions/:id", async (c) => {
    // A staff user can only revoke their own sessions through this route.
    // Cross-user revocation belongs to a separate owner-only endpoint and
    // is not part of v0.1.
    const user = getAuthedUser(c);
    const id = c.req.param("id");
    const sessions = await service.listSessions(user.id);
    const owned = sessions.some((s) => s.id === id);
    if (!owned) {
      throw new ForbiddenError("You can only revoke your own sessions.");
    }
    await service.revokeSession(id);
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------
  // Staff management (owner-only)
  // ---------------------------------------------------------------
  router.post(
    "/staff",
    requireRole("owner"),
    async (c) => {
      const raw = await readJsonBody(c.req.raw);
      const input = parseOrThrow(assignRoleSchema, raw);
      const profile = await service.assignRole(input);
      return c.json(
        {
          authUserId: profile.authUserId,
          role: profile.role,
          displayName: profile.displayName,
          createdAt: profile.createdAt.toISOString(),
          updatedAt: profile.updatedAt.toISOString(),
        },
        201,
      );
    },
  );

  // ---------------------------------------------------------------
  // API keys
  // ---------------------------------------------------------------
  router.get(
    "/api-keys",
    // Owner/admin can manage API keys. Staff and viewer cannot — the
    // surface is operational/security-sensitive.
    requireRole("owner", "admin"),
    async (c) => {
      const user = getAuthedUser(c);
      const keys = await service.listApiKeys(user.id);
      return c.json({
        data: keys.map((k) => ({
          id: k.id,
          name: k.name,
          scopes: k.scopes,
          lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
          createdAt: k.createdAt.toISOString(),
          revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
        })),
      });
    },
  );

  router.post(
    "/api-keys",
    requireRole("owner", "admin"),
    async (c) => {
      const user = getAuthedUser(c);
      const raw = await readJsonBody(c.req.raw);
      const input = parseOrThrow(createApiKeySchema, raw);
      const result = await service.createApiKey({
        userId: user.id,
        name: input.name,
        scopes: input.scopes,
      });
      // The plaintext is returned ONCE here. The caller is responsible for
      // storing it securely; the database does not retain it.
      return c.json(
        {
          id: result.apiKey.id,
          name: result.apiKey.name,
          scopes: result.apiKey.scopes,
          plaintext: result.plaintext,
          createdAt: result.apiKey.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  router.delete(
    "/api-keys/:id",
    requireRole("owner", "admin"),
    async (c) => {
      await service.revokeApiKey(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  return router;
}

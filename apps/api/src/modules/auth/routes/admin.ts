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
 *   - GET    /admin/v1/auth/staff             — list staff profiles (owner-only)
 *   - POST   /admin/v1/auth/staff             — create/update a staff profile (owner-only)
 *   - GET    /admin/v1/auth/api-keys          — list the caller's API keys
 *   - POST   /admin/v1/auth/api-keys          — issue a new API key
 *   - DELETE /admin/v1/auth/api-keys/:id      — revoke an API key
 *
 * Every route requires session auth; the role gates layer on top.
 *
 * Per-endpoint role gates are applied via `router.use(path, ...)` rather
 * than `createRoute({ middleware })` because the latter narrows the route's
 * env to `never` and breaks `c.var.authUser` typing inside the handler.
 *
 * OpenAPI: routes are declared via `createRoute`/`router.openapi(...)`.
 * Better Auth's `/api/auth/*` family is NOT in the spec — that handler is
 * mounted directly on the app at `app.all("/api/auth/*", ...)`.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ForbiddenError } from "../../../lib/errors.js";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AuthAppBindings } from "../middleware.js";
import { assignRoleSchema, createApiKeySchema } from "../types.js";
import type { AuthService } from "../service.js";
import {
  buildRequireAuth,
  buildRequireRole,
  getAuthedUser,
} from "../middleware.js";
import {
  ApiKeyCreated,
  ApiKeyListEnvelope,
  MeAdminResponse,
  SessionListEnvelope,
  StaffListEnvelope,
  StaffProfileFull,
} from "./openapi-schemas.js";

const TAG = "auth (admin)";

const IdParam = z.object({ id: z.string().min(1) });

export function buildAuthAdminRoutes(
  service: AuthService,
): OpenAPIHono<AuthAppBindings> {
  const router = new OpenAPIHono<AuthAppBindings>({
    defaultHook: defaultValidationHook,
  });
  const requireAuth = buildRequireAuth(service);
  const requireRole = buildRequireRole(service);

  // Baseline: every route requires session auth and one of the staff roles
  // (the broadest set including viewer). Tighter per-endpoint gates layer
  // on top via `router.use(path, ...)` below.
  router.use("*", requireAuth());
  router.use("*", requireRole("owner", "admin", "staff", "viewer"));

  // Owner-only:
  router.use("/staff", requireRole("owner"));
  // Owner + admin only — API-key management is operational/security-sensitive.
  router.use("/api-keys", requireRole("owner", "admin"));
  router.use("/api-keys/*", requireRole("owner", "admin"));

  // ---------------------------------------------------------------
  // /me — the caller's staff profile + auth user info
  // ---------------------------------------------------------------
  router.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags: [TAG],
      summary: "Current staff identity + profile",
      responses: {
        200: {
          content: { "application/json": { schema: MeAdminResponse } },
          description: "Caller details.",
        },
        401: errorResponse("Authentication required."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const profile = c.get("staffProfile");
      return c.json(
        {
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
        },
        200,
      );
    },
  );

  // ---------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------
  router.openapi(
    createRoute({
      method: "get",
      path: "/sessions",
      tags: [TAG],
      summary: "List the caller's active sessions",
      responses: {
        200: {
          content: { "application/json": { schema: SessionListEnvelope } },
          description: "Sessions.",
        },
        401: errorResponse("Authentication required."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const sessions = await service.listSessions(user.id);
      return c.json(
        {
          data: sessions.map((s) => ({
            id: s.id,
            expiresAt: s.expiresAt.toISOString(),
            ipAddress: s.ipAddress,
            userAgent: s.userAgent,
            createdAt: s.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "delete",
      path: "/sessions/{id}",
      tags: [TAG],
      summary: "Revoke one of the caller's sessions",
      description:
        "A staff user can only revoke their own sessions through this route. Cross-user revocation belongs to a separate owner-only endpoint and is not part of v0.1.",
      request: { params: IdParam },
      responses: {
        204: { description: "Revoked." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Cannot revoke a session that is not yours."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const id = c.req.param("id");
      const sessions = await service.listSessions(user.id);
      const owned = sessions.some((s) => s.id === id);
      if (!owned) {
        throw new ForbiddenError("You can only revoke your own sessions.");
      }
      await service.revokeSession(id);
      return c.body(null, 204);
    },
  );

  // ---------------------------------------------------------------
  // Staff management (owner-only via the path-scoped use() above)
  // ---------------------------------------------------------------
  router.openapi(
    createRoute({
      method: "get",
      path: "/staff",
      tags: [TAG],
      summary: "List staff profiles (owner-only)",
      description:
        "Returns every staff_profile row joined with the linked auth user's email. Used by the operator-facing staff & roles screen. Owner-only because the list reveals every operator's email and role.",
      responses: {
        200: {
          content: { "application/json": { schema: StaffListEnvelope } },
          description: "Staff profiles.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Owner role required."),
      },
    }),
    async (c) => {
      const rows = await service.listStaff();
      return c.json(
        {
          data: rows.map((row) => ({
            authUserId: row.authUserId,
            role: row.role,
            displayName: row.displayName,
            email: row.email,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/staff",
      tags: [TAG],
      summary: "Create or update a staff profile (owner-only)",
      request: {
        body: { content: { "application/json": { schema: assignRoleSchema } } },
      },
      responses: {
        201: {
          content: { "application/json": { schema: StaffProfileFull } },
          description: "Created or updated profile.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Only owners may assign roles."),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
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
  // API keys (owner/admin only via the path-scoped use() above)
  // ---------------------------------------------------------------
  router.openapi(
    createRoute({
      method: "get",
      path: "/api-keys",
      tags: [TAG],
      summary: "List the caller's API keys (owner/admin only)",
      responses: {
        200: {
          content: { "application/json": { schema: ApiKeyListEnvelope } },
          description: "API keys.",
        },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const keys = await service.listApiKeys(user.id);
      return c.json(
        {
          data: keys.map((k) => ({
            id: k.id,
            name: k.name,
            scopes: k.scopes,
            lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
            createdAt: k.createdAt.toISOString(),
            revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
          })),
        },
        200,
      );
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/api-keys",
      tags: [TAG],
      summary: "Issue a new API key (owner/admin only)",
      description:
        "The plaintext is returned ONCE in the response and not retained anywhere server-side. Callers must store it immediately.",
      request: {
        body: {
          content: { "application/json": { schema: createApiKeySchema } },
        },
      },
      responses: {
        201: {
          content: { "application/json": { schema: ApiKeyCreated } },
          description: "Created key with plaintext.",
        },
        400: errorResponse("Validation failed."),
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
      },
    }),
    async (c) => {
      const user = getAuthedUser(c);
      const input = c.req.valid("json");
      const result = await service.createApiKey({
        userId: user.id,
        name: input.name,
        scopes: input.scopes,
      });
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

  router.openapi(
    createRoute({
      method: "delete",
      path: "/api-keys/{id}",
      tags: [TAG],
      summary: "Revoke an API key (owner/admin only)",
      request: { params: IdParam },
      responses: {
        204: { description: "Revoked." },
        401: errorResponse("Authentication required."),
        403: errorResponse("Forbidden."),
        404: errorResponse("API key not found."),
      },
    }),
    async (c) => {
      await service.revokeApiKey(c.req.param("id"));
      return c.body(null, 204);
    },
  );

  return router;
}

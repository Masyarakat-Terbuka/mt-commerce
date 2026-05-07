/**
 * Auth middlewares — `requireAuth`, `requireRole`, and `requireScope`.
 *
 * `requireAuth` is the primary gate. It:
 *   1. Tries `Authorization: Bearer <key>` first. Bearer keys are checked via
 *      the AuthService (Argon2id verify) and set `c.var.apiKey`.
 *   2. Falls back to a session cookie validated by Better Auth. The
 *      framework's `api.getSession({ headers })` validates the cookie and
 *      returns the user + session.
 *   3. On success, sets `c.var.authUser`, `c.var.authSession` (when a
 *      session was used), `c.var.apiKey` (when an API key was used), and
 *      `c.var.authMode`.
 *   4. On failure, throws `UnauthorizedError` so the standard error envelope
 *      renders consistently.
 *
 * `requireRole(...roles)` sits *after* `requireAuth` and looks up the staff
 * profile. A request with no staff profile, or with a role outside the
 * accepted set, gets a 403 — never a 401, because authentication itself
 * succeeded; only the authorization decision failed.
 *
 * `requireScope(scope)` is the API-key counterpart: routes meant to be
 * called by external services declare which scope they need. A missing
 * scope is a 403.
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  ForbiddenError,
  UnauthorizedError,
} from "../../lib/errors.js";
import type { AppBindings } from "../../lib/types.js";
import { getAuth } from "./better-auth.js";
import type { AuthService } from "./service.js";
import {
  type AuthSession,
  type AuthUser,
  type Role,
  type Scope,
} from "./types.js";

/**
 * The route bindings type. The auth-related context variables are declared
 * on `AppVariables` itself (in `lib/types.ts`), so any router typed as
 * `Hono<AppBindings>` can read `c.var.authUser` after `requireAuth()` has
 * run. We re-export `AppBindings` under a friendlier name so callers do
 * not have to remember which lib file the canonical shape lives in.
 */
export type AuthAppBindings = AppBindings;
/**
 * Re-exported variable interface — the canonical shape lives on
 * `AppVariables` in `lib/types.ts`. The fields are optional there because
 * not every request goes through `requireAuth`.
 */
export type AuthVariables = AppBindings["Variables"];

/**
 * Narrow the optionally-typed `c.var.authUser` to a non-null `AuthUser`.
 *
 * `AppVariables.authUser` is declared optional so routes that do NOT use
 * `requireAuth()` (the global default for unauthenticated endpoints) keep
 * their context type sound. Inside a handler that DID run requireAuth,
 * the value is guaranteed to be set; this helper is the explicit assert
 * point so handlers do not pepper themselves with `c.var.authUser!`.
 *
 * Throws `UnauthorizedError` if the assert fails — defense in depth for
 * the case where a handler forgets to apply `requireAuth()` to its route.
 */
export function getAuthedUser(c: Context<AppBindings>): AuthUser {
  const user = c.get("authUser");
  if (!user) {
    throw new UnauthorizedError();
  }
  // The structural shape on AppVariables matches the AuthUser definition
  // exactly; the cast is the explicit re-narrowing point.
  return user as AuthUser;
}

const BEARER_PREFIX = "Bearer ";

function readBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  if (!headerValue.startsWith(BEARER_PREFIX)) return null;
  const token = headerValue.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export interface RequireAuthOptions {
  /**
   * When false, the middleware sets context vars on success but does NOT
   * throw on missing auth — it just continues. Useful for routes that
   * personalize their response when a caller is logged in but stay public
   * otherwise (e.g. a storefront product detail that toggles a "save for
   * later" button). Default: true.
   */
  required?: boolean;
}

export function buildRequireAuth(
  service: AuthService,
): (options?: RequireAuthOptions) => MiddlewareHandler<AuthAppBindings> {
  return (options = {}) => {
    const required = options.required ?? true;

    return async (c, next) => {
      // 1. API key path
      const bearer = readBearer(c.req.header("authorization"));
      if (bearer) {
        const result = await service.verifyApiKey(bearer);
        if (result) {
          c.set("authUser", result.user);
          c.set("apiKey", result.apiKey);
          c.set("authMode", "api_key");
          await next();
          return;
        }
        // Explicit bearer header that did not validate is always a 401,
        // even when the route is `required: false`. A bad token is a
        // sign of intent — silent fall-through would mask bugs and let
        // attackers probe.
        throw new UnauthorizedError("Invalid API key.");
      }

      // 2. Session cookie path (Better Auth)
      const auth = getAuth();
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });

      if (session?.user && session.session) {
        const user: AuthUser = {
          id: session.user.id,
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          name: session.user.name,
          image: session.user.image ?? null,
          createdAt: new Date(session.user.createdAt),
          updatedAt: new Date(session.user.updatedAt),
        };
        const authSession: AuthSession = {
          id: session.session.id,
          userId: session.session.userId,
          expiresAt: new Date(session.session.expiresAt),
          ipAddress: session.session.ipAddress ?? null,
          userAgent: session.session.userAgent ?? null,
          createdAt: new Date(session.session.createdAt),
        };
        c.set("authUser", user);
        c.set("authSession", authSession);
        c.set("authMode", "session");
        await next();
        return;
      }

      if (required) {
        throw new UnauthorizedError();
      }
      await next();
    };
  };
}

/**
 * `requireRole(...roles)` — must run after `requireAuth`. Looks up the staff
 * profile attached to the authenticated user and rejects if their role is
 * not in the accepted set.
 *
 * The lookup is cached on the context (`c.var.staffProfile`) so a chain that
 * uses both this and a follow-up middleware does not double-query.
 */
export function buildRequireRole(
  service: AuthService,
): (...roles: Role[]) => MiddlewareHandler<AuthAppBindings> {
  return (...roles) => {
    const accepted = new Set<Role>(roles);
    return async (c, next) => {
      const user = c.get("authUser");
      if (!user) {
        // Defense in depth: the route forgot to apply requireAuth first.
        // Treat as 401 rather than crashing.
        throw new UnauthorizedError();
      }

      let profile = c.get("staffProfile");
      if (!profile) {
        const found = await service.getStaffProfile(user.id);
        if (found) {
          profile = found;
          c.set("staffProfile", found);
        }
      }

      if (!profile) {
        throw new ForbiddenError(
          "This action is restricted to staff users.",
        );
      }
      if (!accepted.has(profile.role)) {
        throw new ForbiddenError(
          "Your role does not have access to this action.",
        );
      }
      await next();
    };
  };
}

/**
 * `requireScope(scope)` — for routes meant to be called via API keys. A
 * session-authenticated request fails this check unless the route also
 * accepts session auth and we explicitly skip the scope assertion. v0.1
 * keeps it simple: the middleware demands `c.var.apiKey` to exist and the
 * scope to be present.
 */
export function buildRequireScope(): (
  scope: Scope,
) => MiddlewareHandler<AuthAppBindings> {
  return (scope) => async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) {
      throw new ForbiddenError(
        "This endpoint requires an API key with the appropriate scope.",
      );
    }
    if (!apiKey.scopes.includes(scope)) {
      // We deliberately do not include the requested scope or the API key
      // id in the message — clients should already know what they asked
      // for; surfacing it would only help attackers probe the scope set.
      throw new ForbiddenError("API key is missing the required scope.");
    }
    await next();
  };
}

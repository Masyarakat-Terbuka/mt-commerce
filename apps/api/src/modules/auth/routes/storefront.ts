/**
 * Storefront auth routes — what the customer-facing web app needs beyond the
 * raw Better Auth handler.
 *
 * Better Auth's own handler at `/api/auth/*` already covers the heavy lifting
 * (sign-up, sign-in, sign-out, forget-password, reset-password, get-session,
 * verify-email). This router exposes only the small "who am I" endpoint that
 * the storefront uses to render account state in its layout.
 *
 * Customers do NOT have a staff profile; the response surfaces only the
 * `auth_users` fields. The customer module's profile/address routes live
 * separately (Track B).
 */
import { Hono } from "hono";
import type { AuthAppBindings } from "../middleware.js";
import type { AuthService } from "../service.js";
import { buildRequireAuth } from "../middleware.js";

export function buildAuthStorefrontRoutes(
  service: AuthService,
): Hono<AuthAppBindings> {
  const router = new Hono<AuthAppBindings>();
  const requireAuth = buildRequireAuth(service);

  // GET /storefront/v1/auth/me — null on anonymous, user payload on logged in.
  router.get("/me", requireAuth({ required: false }), (c) => {
    const user = c.get("authUser");
    if (!user) {
      return c.json({ user: null });
    }
    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
    });
  });

  return router;
}

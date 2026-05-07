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
 *
 * Auth middleware is applied via `router.use(path, ...)` rather than the
 * `createRoute({ middleware })` field. The latter narrows the route's
 * environment type when the middleware is generic, which collides with the
 * `AuthAppBindings` we want — `router.use` keeps the env intact.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { defaultValidationHook } from "../../../lib/openapi-shared.js";
import type { AuthAppBindings } from "../middleware.js";
import type { AuthService } from "../service.js";
import { buildRequireAuth } from "../middleware.js";
// Direct import of the customer service singleton — going through the
// customer module's index would pull in `customer/routes/admin.ts`, which
// imports from the `auth` module, creating an import cycle that surfaces
// as `requireAuth is not a function` at module-init time. The service
// module has no transitive dependency on auth, so importing it directly
// breaks the cycle.
import { customerService } from "../../customer/service.js";
import { MeStorefrontResponse } from "./openapi-schemas.js";

const TAG = "auth (storefront)";

export function buildAuthStorefrontRoutes(
  service: AuthService,
): OpenAPIHono<AuthAppBindings> {
  const router = new OpenAPIHono<AuthAppBindings>({
    defaultHook: defaultValidationHook,
  });
  const requireAuth = buildRequireAuth(service);

  // Optional auth on /me — populates `c.var.authUser` when a session is
  // present, no-op otherwise. Applied per-path via `router.use` so the
  // OpenAPI route signature stays clean.
  router.use("/me", requireAuth({ required: false }));

  router.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags: [TAG],
      summary: "Current customer identity (null when anonymous)",
      description:
        "Returns `{ user: null }` for anonymous callers, `{ user: { ... } }` when an authenticated session is present. Used by the storefront layout to render account state.",
      responses: {
        200: {
          content: { "application/json": { schema: MeStorefrontResponse } },
          description: "Caller identity (or null).",
        },
      },
    }),
    async (c) => {
      const user = c.get("authUser");
      if (!user) {
        return c.json({ user: null, customer: null }, 200);
      }
      // Resolve the linked customer so the storefront can render its
      // account header without a second round-trip. The lookup is by
      // `auth_user_id`; the after-sign-up hook in better-auth.ts ensures
      // a row exists. We surface `customer: null` rather than 404 when
      // the link is missing so the UI can recover (e.g. show a
      // recovery/contact CTA) instead of crashing.
      const customer = await customerService.getCustomerByAuthUserId(user.id);
      return c.json(
        {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            emailVerified: user.emailVerified,
          },
          customer: customer
            ? {
                id: customer.id,
                email: customer.email,
                displayName: customer.displayName,
                phone: customer.phone,
              }
            : null,
        },
        200,
      );
    },
  );

  return router;
}

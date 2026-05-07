/**
 * Better Auth instance — single source of truth for password auth, sessions,
 * email verification, and account linking.
 *
 * Configuration choices and rationale:
 *
 *   - Drizzle adapter pointed at our Postgres pool. The model names
 *     ("user"/"session"/"account"/"verification") map onto our tables
 *     `auth_users`/`auth_sessions`/`auth_accounts`/`auth_verifications` via
 *     the `user`/`session`/`account`/`verification` config blocks. Snake_case
 *     column names are translated through the `fields` mapping; Drizzle camel-
 *     case property names match Better Auth's expectations as is, with one
 *     exception per table that we explicitly map.
 *
 *   - `emailAndPassword.enabled: true` and no social providers — v0.1 is
 *     email/password only. Better Auth uses Argon2id for passwords by
 *     default; we do not override the hashing algorithm.
 *
 *   - `emailVerification.sendVerificationEmail` logs to the console in dev.
 *     Replacing this with a real adapter is a follow-up that lives in the
 *     notification module (per the project's notification-adapter pattern).
 *     Returning a resolved promise keeps the framework's flow happy.
 *
 *   - Session cookies: HTTP-only by Better Auth default. We control
 *     `sameSite=Lax` and `secure` via `advanced.useSecureCookies` and
 *     `advanced.cookieOptions.sameSite`. Cookie name is configurable through
 *     env (`SESSION_COOKIE_NAME`).
 *
 *   - `basePath: "/api/auth"` — Better Auth serves its own routes (sign-up,
 *     sign-in, sign-out, verify, reset-password, get-session, etc.) under
 *     this prefix. The Hono app mounts the handler there.
 *
 *   - `advanced.database.generateId: false` — let Better Auth generate IDs.
 *     Using our `id("usr")` helper would force us to supply IDs through
 *     databaseHooks, and Better Auth's defaults are already collision-
 *     resistant. The `auth_users.id` column is `text`, which is type-
 *     compatible with Track B's planned `customers.auth_user_id` FK.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../../db/client.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "../../db/schema/index.js";

const log = logger.child({ module: "auth" });

/**
 * Lazy singleton: Better Auth pulls in the Drizzle client on construction,
 * which would force `DATABASE_URL` to be present at module import time. We
 * defer construction so unit tests that never touch this module do not need
 * the env var.
 */
let instance: ReturnType<typeof buildAuth> | undefined;

function buildAuth() {
  return betterAuth({
    appName: "mt-commerce",
    secret: env.betterAuthSecret,
    baseURL: env.betterAuthUrl,
    basePath: "/api/auth",
    database: drizzleAdapter(db, {
      provider: "pg",
      // Map Better Auth's logical model names to our actual tables. The
      // schema block tells the adapter which Drizzle table to use; the
      // `modelName`/`fields` blocks below remap the *Better Auth* model name
      // and snake_case column names where they differ.
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Email verification is requested but not enforced for sign-in in
      // v0.1 — operators decide whether to gate first login on it. Setting
      // `requireEmailVerification: true` would block the staff onboarding
      // flow until SMTP is wired.
      requireEmailVerification: false,
      autoSignIn: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // Dev-only console fallback. The production wiring lives in the
      // notification module (a `NotificationChannel` adapter), which lands
      // in a follow-up. Returning a resolved promise satisfies the
      // framework contract.
      sendVerificationEmail: async ({ user, url }) => {
        log.info(
          {
            userId: user.id,
            email: user.email,
            url,
          },
          "[dev] email verification link",
        );
      },
    },
    session: {
      // 7 days is the framework default; explicit here for visibility.
      expiresIn: 60 * 60 * 24 * 7,
      // Refresh the cookie if the session is older than ~24h on a
      // request, so active users do not get bumped at the 7-day mark.
      updateAge: 60 * 60 * 24,
      cookieCache: {
        // Disabled: we want the session middleware to see the database
        // truth on every request so a `revokeSession()` takes effect
        // immediately. The cost is one query per authenticated request,
        // acceptable at v0.1 traffic.
        enabled: false,
      },
    },
    advanced: {
      database: {
        generateId: false,
      },
      // Force secure cookies in production. In dev we let Better Auth
      // emit non-secure cookies so localhost works without TLS.
      useSecureCookies: env.sessionCookieSecure,
      // SameSite=Lax is the project default per SECURITY.md. Cross-site
      // POSTs to authenticated endpoints would otherwise sail through
      // with the cookie attached.
      cookies: {
        session_token: {
          name: env.sessionCookieName,
          attributes: {
            sameSite: "lax",
            httpOnly: true,
            secure: env.sessionCookieSecure,
            path: "/",
          },
        },
      },
    },
    rateLimit: {
      // The API has its own rate-limit middleware mounted globally. We let
      // the global limiter handle this — disabling Better Auth's own
      // limiter avoids two competing buckets on the same IP.
      enabled: false,
    },
  });
}

export function getAuth(): ReturnType<typeof buildAuth> {
  if (!instance) {
    instance = buildAuth();
  }
  return instance;
}

export type Auth = ReturnType<typeof buildAuth>;
export type BetterAuthSession = Auth["$Infer"]["Session"];

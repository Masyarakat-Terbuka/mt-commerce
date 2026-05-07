/**
 * Better Auth instance — single source of truth for password auth, sessions,
 * email verification, and account linking.
 *
 * Configuration choices and rationale:
 *
 *   - Drizzle adapter pointed at our Postgres pool. The model names
 *     ("user"/"session"/"account"/"verification") map onto our tables
 *     `auth_users`/`auth_sessions`/`auth_accounts`/`auth_verifications` via
 *     the `user`/`session`/`account`/`verification` config blocks.
 *     Snake_case column names that do NOT match Better Auth's expected camel-
 *     case property names (`emailVerified` → `email_verified`, etc.) are
 *     mapped through explicit `fields:` blocks below. This is defense in
 *     depth: a future Better Auth release that changes its expected names
 *     will fail fast instead of silently writing into the wrong column.
 *
 *   - `emailAndPassword.enabled: true` and no social providers — v0.1 is
 *     email/password only. Better Auth uses Argon2id for passwords by
 *     default; we do not override the hashing algorithm.
 *
 *   - `emailVerification.sendVerificationEmail` is dev-only. In production
 *     the function THROWS unless a notification adapter is wired, because
 *     logging single-use verification URLs into the application log dumps
 *     account-takeover material into operator-readable logs.
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
 *
 *   - `rateLimit` is OWNED by Better Auth on the `/api/auth/*` prefix. The
 *     global `rateLimit()` middleware in `app.ts` skips this prefix to
 *     avoid two competing buckets on the same key. Per-route windows are
 *     declared in `customRules` — sign-in/email is the brute-force-prone
 *     surface and gets the tightest budget (5 per 60s per IP); password-
 *     reset paths get 3 per 5min. The general bucket on the rest of
 *     /api/auth/* is 30 per 60s.
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

/**
 * Construct a fresh Better Auth instance with the project's configuration.
 * Tests call this directly when they need an isolated rate-limit bucket
 * (the default singleton would share state across tests). Production code
 * should use `getAuth()` instead.
 */
export function buildAuth() {
  return betterAuth({
    appName: "mt-commerce",
    secret: env.betterAuthSecret,
    baseURL: env.betterAuthUrl,
    basePath: "/api/auth",
    database: drizzleAdapter(db, {
      provider: "pg",
      // Map Better Auth's logical model names to our actual tables. The
      // schema block tells the adapter which Drizzle table to use.
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    // Explicit `fields:` blocks for columns that don't match Better Auth's
    // default expected names. Drizzle reflects the camelCase property names
    // (e.g. `emailVerified`) but our underlying Postgres columns are
    // snake_case. Better Auth's adapter consults these mappings when it
    // builds queries — without them, a future framework version that begins
    // emitting `email_verified` directly would silently write to the wrong
    // column. Listing them explicitly is the cheapest insurance.
    user: {
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
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
    account: {
      fields: {
        userId: "user_id",
        providerId: "provider_id",
        accountId: "account_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
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
      // in a follow-up.
      //
      // SECURITY: in production we MUST NOT log the verification URL. A
      // verification link is single-use account-takeover material; anyone
      // with read access to the application log would be able to claim a
      // freshly-registered account. Until a real notification adapter is
      // wired, refuse to send and surface a clear runtime error so the
      // operator notices on the very first sign-up attempt rather than
      // through a leaked log line.
      sendVerificationEmail: async ({ user, url }) => {
        if (env.nodeEnv === "production") {
          throw new Error(
            "Notification adapter not yet wired; configure SMTP or wire " +
              "the notification module before signing up users in production.",
          );
        }
        // Dev/test: keep the URL discoverable for local development, but
        // tag it loudly and downgrade to warn so it stands out in the log
        // stream and never accidentally trips a "looks fine" review.
        log.warn(
          {
            userId: user.id,
            email: user.email,
            url,
          },
          "[DEV ONLY] email verification link — do not deploy without a real notification adapter",
        );
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
      // Better Auth owns the rate-limit bucket on /api/auth/*. The global
      // `rateLimit()` middleware in app.ts skips this prefix to avoid two
      // competing buckets on the same key.
      //
      // Enabled in every environment, including tests — the bucket is
      // in-memory (`storage: "memory"`) and per-instance, so tests that
      // need to verify the 429 contract construct a fresh instance via
      // the exported `buildAuth()` builder. The default singleton is
      // never reused across tests.
      //
      // `storage: "memory"` is intentional for v0.1: a database-backed
      // store would require a `rate_limit` table the framework manages
      // (and a Postgres trip per request). Memory is fine for a single-
      // process API; when we move to multi-process we will switch to
      // `secondary-storage` against the existing Redis pool.
      enabled: true,
      storage: "memory",
      // Default bucket for any /api/auth/* route not matched below.
      // 30 per 60s per IP is generous enough for normal session activity
      // (get-session, sign-out, etc.) while still blunting volumetric noise.
      window: 60,
      max: 30,
      // Per-route windows. Path keys are the route under basePath (Better
      // Auth strips `/api/auth` before matching). Tighter buckets on the
      // brute-force-prone surfaces:
      //   - sign-in/email: 5 attempts per 60s per IP. Argon2id verify takes
      //     50–200ms; a higher cap would let an attacker pin a single
      //     account and exhaust CPU.
      //   - forget-password / reset-password: 3 per 5min — these are user-
      //     initiated rare flows and the cost of being wrong is high.
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/forget-password": { window: 60 * 5, max: 3 },
        "/reset-password": { window: 60 * 5, max: 3 },
        "/reset-password/*": { window: 60 * 5, max: 3 },
      },
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

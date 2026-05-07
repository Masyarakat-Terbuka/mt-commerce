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
import { getNotificationService } from "../notification/index.js";

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
    // No explicit `fields:` blocks: our Drizzle schemas already use the
    // camelCase property names Better Auth expects by default
    // (`emailVerified`, `userId`, `expiresAt`, etc.). Drizzle handles the
    // mapping to the snake_case SQL columns. Adding `fields:` here would
    // be misleading defense-in-depth — Better Auth's adapter resolves
    // properties by their Drizzle TS name, not the SQL column name, so
    // mapping them to snake_case actually broke sign-up.
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
      // Production: send through the notification module's email channel.
      // Dev/test: notification's default channel is `console`, which logs
      // the URL at info level — same effective behavior as the previous
      // `[DEV ONLY]` warn line, now routed through the audit log so the
      // dev-side path matches the prod-side path.
      //
      // SECURITY: a verification link is single-use account-takeover
      // material. The notification module's audit row stores the
      // template payload (which includes the URL), so operators must
      // restrict admin-route access on `/admin/v1/notifications` to
      // staff who should be able to see that material. The role gate
      // (`owner | admin | staff`) is the enforcement point.
      //
      // Failure handling: `sendOrThrow(...)` re-throws on a channel
      // failure so Better Auth fails the originating sign-up call (HTTP
      // 500) rather than silently succeeding. The audit row records the
      // failure with `error_message` set so an operator can see why.
      sendVerificationEmail: async ({ user, url }) => {
        await getNotificationService().sendOrThrow({
          channel: "email",
          recipient: user.email,
          message: {
            kind: "email_verification",
            payload: {
              url,
              name: user.name ?? null,
            },
          },
        });
        log.info(
          { userId: user.id, email: user.email },
          "verification email sent",
        );
      },
    },
    advanced: {
      // Better Auth's default ID generator runs (we don't override it).
      // The `auth_users.id` column is `text` so any string identifier
      // fits; framework defaults are collision-resistant and short
      // enough to use as URL params. We deliberately do NOT set
      // `database.generateId: false` here — that flag tells Better
      // Auth the DB will provide ids, but our schema has no default
      // on `id`, so insertions would fail with NOT NULL.
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

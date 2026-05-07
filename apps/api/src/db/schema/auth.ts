/**
 * Better Auth — core tables.
 *
 * The four tables Better Auth's email/password flow expects: `user`, `session`,
 * `account`, and `verification`. The shapes here mirror Better Auth's default
 * Drizzle schema generator output (see https://better-auth.com/docs and
 * `npx @better-auth/cli generate`). Column names use snake_case to match the
 * rest of the schema; the Drizzle field names are camelCase per project style.
 *
 * IDs are `text` so the same column type is shared with the rest of the
 * platform and Track B's `customers.auth_user_id` FK can target it without
 * a type cast. Better Auth generates IDs server-side; we let it do that
 * rather than overriding with our `id("usr")` helper because the framework
 * provides its own collision-resistant generator and the cookie-cache layer
 * relies on it.
 *
 * `account` carries the password hash (Argon2id) for credential providers and
 * the linked-account record for OAuth providers. Storing it on `account`
 * (rather than `user`) is Better Auth's convention and matters because it
 * lets a single user link multiple credential/social identities cleanly. We
 * only enable the credential provider in v0.1, but the shape is forward-
 * compatible.
 *
 * `session` rows back HTTP-only cookies. They are the source of truth for
 * "is this caller authenticated?" — there is no in-memory cache that would
 * survive a process restart.
 *
 * `verification` is a generic key/value store Better Auth uses for one-shot
 * tokens (email verification, password reset, etc.).
 */
import {
  boolean,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references((): AnyPgColumn => authUsers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authAccounts = pgTable("auth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references((): AnyPgColumn => authUsers.id, { onDelete: "cascade" }),
  /** "credential" for email/password; the provider key for OAuth providers. */
  providerId: text("provider_id").notNull(),
  /** External identifier (the user.id for credential, the OAuth subject for social). */
  accountId: text("account_id").notNull(),
  /** Argon2id hash of the password for credential accounts. NULL for OAuth. */
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authVerifications = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  /** Composite key (e.g. "email-verification:user@example.com"). */
  identifier: text("identifier").notNull(),
  /** Random token sent to the user. */
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type AuthUserRow = typeof authUsers.$inferSelect;
export type NewAuthUserRow = typeof authUsers.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type NewAuthSessionRow = typeof authSessions.$inferInsert;
export type AuthAccountRow = typeof authAccounts.$inferSelect;
export type NewAuthAccountRow = typeof authAccounts.$inferInsert;
export type AuthVerificationRow = typeof authVerifications.$inferSelect;
export type NewAuthVerificationRow = typeof authVerifications.$inferInsert;

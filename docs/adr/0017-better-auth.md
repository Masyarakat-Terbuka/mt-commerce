# ADR-0017: Better Auth for authentication

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** mt-commerce maintainers

---

## Context

mt-commerce needs three authentication contexts in v0.1: staff users signing into the admin (browser session), customers signing into the storefront (browser session), and external services calling the API on behalf of an operator (long-lived bearer credentials with scopes).

Each context has the same primitives — accounts, password hashing, sessions, email verification, password reset, rate-limited sign-in — that a commerce platform should not be rolling itself. The 2010s lesson the open-source ecosystem absorbed is that hand-written auth is the place teams ship security bugs by accident.

The choice space:

**Hand-rolled auth.** Argon2id from a vetted library, sessions in Postgres, cookie middleware. Maximum control. Minimum maturity — every edge case (token rotation, replay protection, account lockout, email-verification flows) has to be re-derived and re-tested.

**A framework-owned auth library.** Better Auth, Lucia, Auth.js (formerly NextAuth), and Hanko are the obvious candidates. Each handles the primitives above and exposes them as a single mounted router or set of helpers.

**A managed auth service.** Clerk, Supabase Auth, Auth0, WorkOS. Outsource sessions and password hashing entirely. Zero auth code to own, but an external dependency in the critical path of every login.

A v0.1 sized for a single VPS deployment cannot reasonably take on a managed external dependency for sign-in: an outage at the auth provider is a complete-store outage. Hand-rolled is too much surface to cover well in v0.1's timeline. That points at a framework-owned library.

Within that bucket, the relevant axes for mt-commerce are:

- **Hono compatibility.** The api is Hono. The chosen library has to mount cleanly into Hono routes without dragging in a framework adapter for Express or Next.js.
- **Database-owned sessions.** Sessions need to live in Postgres alongside the rest of the data so they back up with the rest, are inspectable from operators' usual tools, and are not lost on a container restart.
- **Argon2id by default.** The hashing algorithm is not negotiable.
- **API keys as a first-class concept.** The library has to support long-lived bearer credentials with scopes, not only browser sessions, because external integrations (Biteship webhooks, marketplace syncs) can't carry session cookies.
- **Staff vs. customer separation.** mt-commerce has two distinct user populations that should not see each other's password reset emails or appear in each other's "users" lists.

---

## Decision

mt-commerce uses **Better Auth** as the authentication library, mounted at `/api/auth/*` on the api process. Better Auth owns the four auth tables (`auth_users`, `auth_sessions`, `auth_accounts`, `auth_verifications`) and provides Argon2id hashing, session cookies, email verification, and password-reset flows.

The mt-commerce auth module wraps Better Auth and adds the platform's domain layer:

- **`staff_profiles`** — a domain marker that turns an auth user into staff, holds the role (`owner | admin | staff | viewer`), and is the FK target for staff-only audit columns.
- **`api_keys`** — long-lived bearer credentials with scopes, stored as a salted hash of the secret. API keys are not a Better Auth concept; they are mt-commerce's own table consulted by a separate middleware path.
- **`customers.auth_user_id`** — a nullable FK from the customer record to the same `auth_users` table. A customer "is" an `auth_users` row plus a `customers` row. Staff and customers share one identity table on the assumption that one human can in principle be both during development; in production they are typically one or the other.

A single sign-in endpoint serves both staff and customers; the role determines what the session unlocks.

Authorization is enforced by two Hono middlewares:

- `requireAuth()` — pulls the session cookie, resolves to a user, populates the request context. Or for `/admin/v1/*` and external integrations, falls back to the `Authorization: Bearer apik_…` API-key path.
- `requireRole(...roles)` — gates routes by role. The role list is closed at v0.1 (no per-resource ACLs).

External services use API keys exclusively. The keys carry an explicit scope set; the middleware rejects requests that do not have a scope matching the route's required scope.

---

## Consequences

### Positive

The library handles the parts of auth that are easy to get subtly wrong: cookie attributes (HttpOnly, Secure, SameSite), CSRF defaults, rate-limited sign-in, replay protection on the verification tokens, the password-reset email-token flow. mt-commerce's auth module focuses on the domain concerns above the framework — roles, API keys, staff profiles.

Sessions live in Postgres, in a table that is part of the same logical database as orders and payments. Backup, restore, and disaster-recovery procedures cover sessions automatically. An operator inspecting "who is currently signed in" runs a normal `SELECT` against `auth_sessions`.

The Hono integration is minimal — Better Auth exposes a request handler that mounts at a single path. The api carries no Express or Next.js shim.

A single `auth_users` table for both staff and customers keeps the email-verification and password-reset flows uniform. A customer who is later promoted to staff (rare but plausible — a merchant who hires their best customer) does not need to re-verify their email or reset their password.

API keys are owned by mt-commerce, not by Better Auth. The boundary lets the platform carry concepts the library doesn't — scopes per key, last-used timestamps, the "show the secret once on creation" affordance. The key-resolution middleware is a separate concern from the session middleware and they do not interfere.

### Negative

mt-commerce now depends on Better Auth's release cadence and breaking-change policy. A 2.0 with schema changes will require a coordinated migration. Better Auth's table shape is part of mt-commerce's public surface for any operator who runs raw SQL against the database.

The single-table design for staff and customers means a careless query that says "list all users" returns both populations. Every list endpoint that wants only one population has to filter on `EXISTS staff_profiles` or `EXISTS customers.auth_user_id`. The `authService.listUsers` helpers do this; ad-hoc SQL in admin scripts has to remember.

Better Auth ships its own migrations through its own CLI. mt-commerce wraps them inside the platform's drizzle-kit migration set so an operator runs `bun migrate` and gets both. The wrap is necessary because operators should not have to learn two migration tools, but it does mean a Better Auth schema change has a manual step in the platform's migration generator.

The first-owner provisioning step is a CLI invocation, not a UI flow. An operator standing up a fresh deployment runs `bun --filter '@mt-commerce/api' provision-owner <email>` after signing up through Better Auth. We considered a `?bootstrap=true` flag on the sign-up route guarded by a setup token; it was rejected because the bootstrap surface stays exposed past first use even when nominally disabled. The CLI is the safer pattern at the cost of one extra command.

API-key secrets are shown to the operator exactly once on creation. The hash in `api_keys.secret_hash` is irreversible. An operator who loses the secret rotates the key. The library does not help here; mt-commerce owns the table, the hashing, and the rotation flow.

---

## What this module does NOT do

- **OAuth / social sign-in.** v0.1 ships email + password only. Better Auth supports OAuth out of the box; mt-commerce does not yet expose it because the merchant audience is small businesses whose customers expect a plain email/password flow. A later release adds Google + Facebook for the customer surface only.
- **MFA / TOTP / passkeys.** Better Auth supports them; v0.1 does not enable them. The merchant audience is not yet asking, and the support surface (lost-device recovery, admin reset) is non-trivial.
- **Per-resource ACLs.** The role gate is the only authorization primitive. A `staff` user has the same permissions on every product as on every other product. Per-product permissions wait until a deployment has more than one staff member regularly using them.
- **Session impersonation by admins.** No "log in as this customer" affordance. The audit-log surface lets staff see customer activity without becoming them.
- **External SSO / SAML.** Out of scope for v0.1. The first commercial deployments are individual merchants, not enterprises with directories.

---

## Alternatives considered

### Lucia

Lucia is the closest peer to Better Auth in the TypeScript ecosystem. It pre-dates Better Auth and has a mature codebase. We considered it and chose Better Auth because Lucia's v3 redesign removed the built-in OAuth and verification-token primitives, pushing them onto the application. The savings in api-side code are larger with Better Auth.

If Better Auth's release cadence becomes a problem, Lucia is a credible swap target. The auth module's public surface (`authService`, `requireAuth`, `requireRole`) is library-agnostic by design.

### Auth.js (formerly NextAuth)

Auth.js works well in Next.js and acceptably elsewhere. Its non-Next adapters are second-tier and the documentation reflects it. mt-commerce's api is Hono, not Next.js, and we did not want a fragile adapter on the critical path of every login.

### Hand-rolled auth on top of Argon2id + a sessions table

Considered seriously. Rejected because v0.1's timeline does not have room to absorb the full edge-case set. The list of things that have to be right (timing-attack-safe email lookup, replay protection on verification tokens, secure cookie attributes, CSRF defaults, rate-limited sign-in, account-lockout heuristics) is not the place to be original. A library that has had hundreds of contributors look at it is the right answer for a v0.1.

We may revisit this in a few releases if the dependency starts costing more than it saves, but the current calculus favours the library.

### Clerk / Supabase Auth / Auth0

External managed auth was rejected as a v0.1 default for two reasons. First, an outage at the provider takes the store down — sign-in stops, customer browsing partially stops, the admin stops. mt-commerce targets merchants on a single VPS who cannot accept that coupling. Second, the cost model (per-MAU pricing) is wrong for a self-hosted commerce platform; the merchant pays per-customer for a primitive their database already supports.

A managed-auth deployment mode could be added later as a plugin (the auth module's `authService` interface is the seam). It is not the default.

### Two Better Auth instances — one for staff, one for customers

Considered for the staff/customer separation. Rejected because two instances would mean two `auth_users` tables, two sets of email-verification flows, two cookie names, and two rate-limit buckets. The savings (a "users" list filtered for free) are not worth the duplication. A single instance with a domain marker (`staff_profiles`) gets the same end result with less configuration.

---

## Related

- [ADR-0005](./0005-modular-monolith.md) — module boundaries; the auth module is the only module that touches the `auth_*` tables.
- [ADR-0011](./0011-audit-log.md) — staff actions are audited via the actor stamp the auth middleware populates.
- `apps/api/src/modules/auth/` — the module.
- `apps/api/src/modules/auth/better-auth.ts` — the Better Auth wiring.
- `apps/api/src/scripts/provision-owner.ts` — the first-owner CLI.

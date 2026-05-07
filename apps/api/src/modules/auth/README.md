# Auth module

Owns staff authentication, customer authentication, role-based authorization,
session management, and API keys. Authentication is delegated to
[Better Auth](https://better-auth.com); this module wires it into the app and
adds the staff-profile / API-key layer on top.

Per ADR-0005, no other module reaches into the auth tables directly.
Cross-module callers go through `authService` and the exported middleware.

## Schemas

All under `apps/api/src/db/schema/`:

| Table                | Purpose                                           | ID prefix |
| -------------------- | ------------------------------------------------- | --------- |
| `auth_users`         | Better Auth identity (email, name, verified flag) | (BA gen)  |
| `auth_sessions`      | Active session rows backing HTTP-only cookies     | (BA gen)  |
| `auth_accounts`      | Credential / OAuth account records (Argon2id hash)| (BA gen)  |
| `auth_verifications` | One-shot tokens (email verify, password reset)    | (BA gen)  |
| `staff_profiles`     | Domain marker that turns an auth user into staff  | —         |
| `api_keys`           | Long-lived bearer credentials with scopes         | `apik_`   |

## Staff profile model — Option A

A single Better Auth `auth_users` table is the auth identity. A user is
"staff" if a `staff_profiles` row exists for them, "customer" if Track B's
`customers.auth_user_id` points at the same `auth_users.id`. A user could in
principle be both during development testing but in production they are
typically one or the other.

Why this over option B (two Better Auth instances): one identity simplifies
sessions, password reset, email verification, and rate-limit bookkeeping.
The boundary between staff and customer is a domain concern, not a
framework concern.

### First-staff = owner

`AuthService.assignRole` enforces that the FIRST staff_profile must be
`owner`. Subsequent calls accept any role. This rule lives in the service
(not the route) so seed scripts cannot bypass it.

### First-owner provisioning

The auth identity must exist before it can be promoted, because
`staff_profiles.auth_user_id` is a FK into `auth_users`. The flow is two
steps:

1. Sign the user up through Better Auth (storefront UI, admin sign-up
   route, or `curl POST /api/auth/sign-up/email`). This populates
   `auth_users` and `auth_accounts` (Argon2id hash on the latter).
2. Run the CLI:

   ```bash
   bun --filter '@mt-commerce/api' provision-owner <email>
   ```

The CLI is at `apps/api/src/scripts/provision-owner.ts`. It looks the user
up by email (case-insensitive), then calls `AuthService.assignRole` —
which is what enforces the first-staff-must-be-owner invariant inside a
transaction. Behavior:

- No auth user → prints a clear error, exits 1.
- Already owner → no-op, exits 0 (idempotent).
- Existing non-owner role → prompts `[y/N]` before promoting; pass
  `--yes`/`-y` to skip the prompt for non-interactive use.
- No staff profile → creates one with role `owner`, using the auth user's
  name as the display name.

A previously-considered alternative — a `?bootstrap=true` flag on the
Better Auth sign-up route guarded by a setup token — was rejected as
weaker (the bootstrap surface stays exposed even after first use).

## Public API

```ts
import {
  authService,
  requireAuth,
  requireRole,
  requireScope,
  type Role,
  type Scope,
  type AuthAppBindings,
} from "./modules/auth";
```

### Service interface (excerpt)

```ts
interface AuthService {
  getStaffProfile(authUserId: string): Promise<StaffProfile | null>;
  assignRole(input: { authUserId; role; displayName }): Promise<StaffProfile>;
  /**
   * Soft disable: downgrades the staff_profile role to `viewer` and
   * revokes every active session. Refuses on the last `owner` (would
   * leave the platform ownerless).
   *
   * Soft over hard because:
   *   - it preserves the audit trail (who did what before disable);
   *   - it lets an accidentally-disabled user be restored without
   *     recreating identity;
   *   - it requires no schema change — the `viewer` role already
   *     exists, and every mutating role gate excludes it.
   */
  disableUser(authUserId: string): Promise<void>;
  listSessions(userId: string): Promise<AuthSession[]>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(userId: string): Promise<void>;
  createApiKey(input): Promise<{ apiKey: ApiKey; plaintext: string }>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
  revokeApiKey(id: string): Promise<void>;
  verifyApiKey(bearer: string): Promise<{ apiKey; user } | null>;
}
```

### Middleware

- `requireAuth({ required? })` — accepts an `Authorization: Bearer <key>`
  API key OR a session cookie. Sets `c.var.authUser` and either
  `c.var.authSession` or `c.var.apiKey`. Throws 401 when no auth is
  present and `required` is true.
- `requireRole(...roles)` — must run after `requireAuth`. Looks up the
  staff profile and rejects with 403 if the user is not staff or their
  role is not in the accepted set.
- `requireScope(scope)` — gates routes meant to be called by API keys.
  Throws 403 if the caller did not authenticate with an API key carrying
  the requested scope.

### Roles

Fixed set: `owner`, `admin`, `staff`, `viewer`. See ARCHITECTURE.md for the
authorization model.

### Scopes (starter set)

| Scope               | Use                                                       |
| ------------------- | --------------------------------------------------------- |
| `catalog:read`      | Read-only access to catalog endpoints (e.g. an external sync) |
| `catalog:write`     | Create/update products, variants, inventory                  |
| `webhooks:receive`  | Inbound webhook receivers (e.g. Midtrans, Biteship)          |

Adding a scope is one entry in `SCOPES` plus a doc update.

## HTTP routes

### Better Auth handler (mounted at `/api/auth/*`)

Better Auth ships its own routes — sign-up, sign-in, sign-out, forget /
reset password, verify email, get session. The Hono app mounts the
framework's handler at `/api/auth/*`. See the
[Better Auth API docs](https://better-auth.com/docs).

### Admin (mounted at `/admin/v1/auth`)

Every route requires session auth. Role gates per row.

| Method | Path                              | Role requirement       |
| ------ | --------------------------------- | ---------------------- |
| GET    | `/admin/v1/auth/me`               | any staff role         |
| GET    | `/admin/v1/auth/sessions`         | any staff role         |
| DELETE | `/admin/v1/auth/sessions/:id`     | any staff role (own)   |
| POST   | `/admin/v1/auth/staff`            | `owner` only           |
| GET    | `/admin/v1/auth/api-keys`         | `owner` or `admin`     |
| POST   | `/admin/v1/auth/api-keys`         | `owner` or `admin`     |
| DELETE | `/admin/v1/auth/api-keys/:id`     | `owner` or `admin`     |

### Storefront (mounted at `/storefront/v1/auth`)

| Method | Path                          | Notes                                                                |
| ------ | ----------------------------- | -------------------------------------------------------------------- |
| GET    | `/storefront/v1/auth/me`      | Returns `{ user, customer }` (both nullable). The `customer` summary lets the storefront resolve `customerId` without a second round-trip. |

### Customer provisioning on sign-up

The Better Auth handler at `/api/auth/sign-up/email` is the canonical
sign-up route for customers. A `databaseHooks.user.create.after` hook in
`better-auth.ts` mints a `customers` row with `auth_user_id` set whenever
a new auth user is created. If a `customers` row already exists at the
sign-up email (typical of guest checkout) and is unlinked, the hook
promotes it in place by attaching the new `auth_user_id`. This keeps the
flow single-call from the storefront's perspective: `signUp()` followed by
`me()` returns a fully-linked identity.

## How other modules use this

```ts
// apps/api/src/modules/catalog/routes/admin.ts
import { requireRole } from "../../auth";

router.use("*", requireAuth());
router.use("*", requireRole("owner", "admin", "staff"));
```

Routes that accept API keys gate on a scope:

```ts
import { requireAuth, requireScope } from "../../auth";

router.post(
  "/webhooks/midtrans",
  requireAuth(),
  requireScope("webhooks:receive"),
  handler,
);
```

## API-key bearer format

`<apik_id>.<secret>`. Both halves are ULID-shaped; the dot delimiter is
unambiguous. The plaintext is shown ONCE at creation; the database stores
only the Argon2id hash of the secret half.

```
Authorization: Bearer apik_01HZX....SECRETPART
```

## Environment

| Var                       | Required        | Purpose                                            |
| ------------------------- | --------------- | -------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | yes (≥ 32 char) | Cookie signing + verification token encryption     |
| `BETTER_AUTH_URL`         | optional        | Base URL for callbacks; defaults to `http://localhost:$PORT` |
| `SESSION_COOKIE_NAME`     | optional        | Defaults to `mt_session`                           |
| `SESSION_COOKIE_SECURE`   | optional        | Defaults to `NODE_ENV === "production"`            |

Generate a secret with `openssl rand -base64 32`.

## TODO follow-ups

- Real email-sending adapter (notification module) — currently logs to console
- Per-route rate limits on auth endpoints (the global limiter handles
  baseline; auth-specific buckets are warranted for sign-in/forget-password)
- Audit log integration for role changes and API-key revocation
- Multi-session revocation UI (revoking ALL sessions other than the current)
- OpenAPI annotations via `@hono/zod-openapi`

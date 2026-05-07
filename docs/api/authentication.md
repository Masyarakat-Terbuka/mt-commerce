# Authentication

mt-commerce uses [Better Auth](https://better-auth.com) for password-based
authentication and HTTP-only session cookies, plus a small layer on top for
staff roles and API keys.

This document is for operators wiring the platform into a deployment. For the
developer-facing module overview, see
[`apps/api/src/modules/auth/README.md`](../../apps/api/src/modules/auth/README.md).

---

## Concepts

There are two audiences:

- **Staff** — shop owners and their teams using the admin app.
- **Customers** — shoppers using the storefront.

Both authenticate against the same identity table (`auth_users`), but staff
also have a row in `staff_profiles` that carries a role
(`owner | admin | staff | viewer`). A user without a `staff_profiles` row
cannot reach `/admin/v1/...` routes — even if the cookie is valid.

External services (payment provider webhooks, marketplace sync workers) use
**API keys** instead of cookies. Keys carry explicit scopes
(`catalog:read`, `catalog:write`, `webhooks:receive`).

---

## Sessions

When a user signs in with email and password, Better Auth issues a session
cookie:

| Property      | Value                                              |
| ------------- | -------------------------------------------------- |
| Name          | `mt_session` (configurable via `SESSION_COOKIE_NAME`) |
| HttpOnly      | always                                             |
| Secure        | true in production, configurable via `SESSION_COOKIE_SECURE` |
| SameSite      | `Lax`                                              |
| Path          | `/`                                                |
| Expires       | 7 days from issue                                  |
| Refreshed     | every 24 hours of activity                         |

The session row in `auth_sessions` is the source of truth — there is no
in-memory cache. Calling `DELETE /admin/v1/auth/sessions/:id` revokes a
session immediately on the next request.

### Endpoints (provided by Better Auth)

Mounted at `/api/auth/*`:

| Method | Path                                  | Purpose                |
| ------ | ------------------------------------- | ---------------------- |
| POST   | `/api/auth/sign-up/email`             | Register               |
| POST   | `/api/auth/sign-in/email`             | Sign in                |
| POST   | `/api/auth/sign-out`                  | Sign out               |
| POST   | `/api/auth/forget-password`           | Initiate password reset|
| POST   | `/api/auth/reset-password`            | Complete password reset|
| POST   | `/api/auth/verify-email`              | Verify email           |
| GET    | `/api/auth/get-session`               | Read current session   |

Refer to the [Better Auth API docs](https://better-auth.com/docs) for
request and response shapes.

---

## Passwords

Hashed with **Argon2id** (the OWASP-recommended algorithm for new
deployments). Better Auth's defaults apply:

- Memory: 64 MiB
- Iterations: 2
- Parallelism: 1
- Variant: Argon2id

Minimum password rules at the API boundary: 12 characters, including at
least one letter and one digit. The full password is hashed; we do not
store anything else about it.

---

## Email verification

Better Auth's `sendOnSignUp` is enabled. In development, the verification
URL is logged to the console with module `auth`:

```
[dev] email verification link
{ userId: '...', email: '...', url: 'http://localhost:8000/api/auth/verify-email?token=...' }
```

A real email adapter lives in the notification module (a follow-up). To
require email verification before sign-in, set `requireEmailVerification`
to `true` in `apps/api/src/modules/auth/better-auth.ts` and rebuild.

---

## Provisioning the first owner

mt-commerce enforces in code: the FIRST staff user must have role `owner`.
The check lives in `AuthService.assignRole` so a seed script cannot quietly
create a non-owner first staff and lock the platform out.

The auth user must exist before they can be promoted (the `staff_profiles`
row points at `auth_users.id`), so provisioning is a two-step flow.

First, sign the user up:

```bash
curl -X POST http://localhost:8000/api/auth/sign-up/email \
  -H "content-type: application/json" \
  -d '{"email":"owner@example.com","password":"...","name":"Owner"}'
```

Then promote them to owner using the CLI:

```bash
bun --filter '@mt-commerce/api' provision-owner owner@example.com
```

The CLI is idempotent — running it twice on the same user is a no-op. If
the target user already has a non-owner staff role, the CLI prompts for
confirmation before promoting; pass `--yes` (or `-y`) to skip the prompt
in non-interactive contexts.

After promotion, sign in with the same credentials. Subsequent staff can
be created through `POST /admin/v1/auth/staff` while authenticated as the
owner.

---

## API keys

API keys are for external services. They authenticate via the `Authorization`
header instead of a cookie:

```
Authorization: Bearer apik_01HZX....SECRETPART
```

The format is `<id>.<secret>`. Both halves are ULID-shaped. The id is logged
in audit trails; the secret half is never logged or stored — the database
keeps only an Argon2id hash.

### Lifecycle

1. An owner or admin POSTs `/admin/v1/auth/api-keys` with a name and an
   array of scopes:
   ```json
   { "name": "Midtrans webhook receiver", "scopes": ["webhooks:receive"] }
   ```
2. The response includes `plaintext` ONCE:
   ```json
   {
     "id": "apik_01HZX...",
     "name": "Midtrans webhook receiver",
     "scopes": ["webhooks:receive"],
     "plaintext": "apik_01HZX....SECRETPART",
     "createdAt": "2026-05-07T..."
   }
   ```
3. Store the plaintext somewhere safe (a secret manager). It cannot be
   re-fetched.
4. Revoke at any time with `DELETE /admin/v1/auth/api-keys/:id`. The row
   is soft-deleted (sets `revoked_at`) so historical use is auditable.

### Scopes

Routes meant to be called by API keys declare a scope. v0.1 starter set:

| Scope               | Use                                        |
| ------------------- | ------------------------------------------ |
| `catalog:read`      | Read-only access to catalog endpoints      |
| `catalog:write`     | Mutate products, variants, inventory       |
| `webhooks:receive`  | Inbound webhook receivers                  |

Adding a scope is a one-line change in `apps/api/src/modules/auth/types.ts`.

---

## Roles

| Role     | Capability                                                       |
| -------- | ---------------------------------------------------------------- |
| `owner`  | Full access, including team and account settings                 |
| `admin`  | Full access except team and account settings                     |
| `staff`  | Manage products, orders, customers (no API-key management)       |
| `viewer` | Read-only access                                                 |

The catalog admin routes (`/admin/v1/products`, etc.) are gated to
`owner`, `admin`, `staff`. Adding `viewer` to read-only routes is a
follow-up once a separate read-only sub-router lands.

---

## Environment

| Variable                | Required                  | Notes                                                        |
| ----------------------- | ------------------------- | ------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`    | yes (≥ 32 chars)          | Cookie signing + verification token encryption               |
| `BETTER_AUTH_URL`       | optional in dev, yes prod | Base URL for callbacks and origin verification               |
| `SESSION_COOKIE_NAME`   | optional                  | Defaults to `mt_session`                                     |
| `SESSION_COOKIE_SECURE` | optional                  | Defaults to true when `NODE_ENV=production`                  |

Generate a secret with:

```bash
openssl rand -base64 32
```

Rotating the secret invalidates ALL existing sessions and verification
tokens. Plan the rotation accordingly.

---

## Failure modes

| Status | Code                | When                                                |
| ------ | ------------------- | --------------------------------------------------- |
| 401    | `unauthorized`      | No session, expired session, or bad API key         |
| 403    | `forbidden`         | Authenticated, but role/scope is not in the set     |
| 400    | `validation_error`  | Body or query failed Zod validation                 |

All responses use the standard envelope:

```json
{ "error": { "code": "...", "message": "...", "details": {} } }
```

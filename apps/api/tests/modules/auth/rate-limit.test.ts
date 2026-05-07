/**
 * B1 — Better Auth's per-route rate limiter must blunt brute force on the
 * `/api/auth/sign-in/email` endpoint. Without it (or with the global
 * limiter's 120/min default), an attacker can pin a single account and
 * exhaust CPU on Argon2id verifies.
 *
 * The test stands up a fresh Better Auth instance via the in-memory
 * adapter so it has no DB dependency. It mirrors the prod config's
 * `rateLimit.customRules` for `/sign-in/email` (5 per 60s per IP) and
 * issues 6 sign-in attempts. The first 5 are rejected by Better Auth
 * itself (no such user → 401), but they consume the rate-limit budget;
 * the 6th must be rejected by the limiter with HTTP 429 BEFORE the
 * handler runs.
 *
 * We construct the auth instance directly rather than using the
 * project's `getAuth()` singleton because:
 *   1. The singleton wires the Postgres-backed Drizzle adapter, which
 *      requires DATABASE_URL.
 *   2. The Better Auth in-memory rate-limit store is a module-level
 *      Map shared across instances. A fresh instance still shares the
 *      bucket, so we use a unique IP via `x-forwarded-for` and tell
 *      Better Auth to trust that header — the bucket key includes the
 *      IP, so two tests do not cross-contaminate.
 */
import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

function buildIsolatedAuth() {
  return betterAuth({
    appName: "mt-commerce-test",
    secret: "test-secret-test-secret-test-secret-test",
    baseURL: "http://localhost:8000",
    basePath: "/api/auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    advanced: {
      // Trust the test's `x-forwarded-for` header so each test gets its
      // own IP-keyed bucket — the module-level memory store would
      // otherwise cross-contaminate runs.
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
      },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
      },
    },
  });
}

describe("Better Auth rate limit — /sign-in/email", () => {
  it("returns 429 on the 6th attempt from the same IP within the window", async () => {
    const auth = buildIsolatedAuth();

    // Use a unique IP so this test's bucket does not collide with any
    // other test that also targets /sign-in/email. The Better Auth
    // memory store is module-level and survives across `betterAuth()`
    // constructions.
    const TEST_IP = "203.0.113.1";

    const issueSignIn = async (): Promise<Response> =>
      auth.handler(
        new Request("http://localhost:8000/api/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": TEST_IP,
          },
          body: JSON.stringify({
            email: "nobody@example.com",
            password: "doesnotmatter1234",
          }),
        }),
      );

    // First 5: handler runs (no such user → 401 from Better Auth, not 429).
    for (let i = 1; i <= 5; i++) {
      const res = await issueSignIn();
      expect(
        res.status,
        `attempt ${i.toString()} must NOT be rate-limited`,
      ).not.toBe(429);
    }

    // 6th: rate-limited.
    const sixth = await issueSignIn();
    expect(sixth.status).toBe(429);
  });
});

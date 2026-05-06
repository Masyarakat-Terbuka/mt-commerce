/**
 * Covers the body-handling matrix for `POST /v1/ping`:
 *
 *   - empty body                → 200 (tolerated)
 *   - valid JSON, no fields    → 200 (tolerated)
 *   - malformed JSON           → 400 invalid_json
 *
 * The DB write is mocked via `__setDbForTesting` so the test runs without a
 * Postgres connection. Errors are routed through the standard error handler
 * to verify the wire shape clients see.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildPingRoutes } from "../../src/routes/v1/ping.js";
import { errorHandler } from "../../src/middleware/error-handler.js";
import { __setDbForTesting } from "../../src/db/client.js";
import type { AppBindings } from "../../src/lib/types.js";

interface PingSuccessBody {
  ok: boolean;
  id: string;
  pingedAt: string;
}

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route("/v1", buildPingRoutes());
  app.onError(errorHandler);
  return app;
}

/** Stub Drizzle client: returns a deterministic row from `.returning()`. */
function installFakeDb(): void {
  const fakeReturning = async (): Promise<Array<{ id: string; pingedAt: Date }>> => {
    return [{ id: "ping_test", pingedAt: new Date("2026-05-07T00:00:00Z") }];
  };
  const fake = {
    insert: () => ({
      values: () => ({ returning: fakeReturning }),
    }),
  };
  __setDbForTesting(fake as unknown as Parameters<typeof __setDbForTesting>[0]);
}

describe("POST /v1/ping body handling", () => {
  afterEach(() => {
    __setDbForTesting(undefined);
  });

  it("tolerates an empty body (no Content-Type, no payload)", async () => {
    installFakeDb();
    const app = buildApp();
    const res = await app.request("/v1/ping", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PingSuccessBody;
    expect(body.ok).toBe(true);
  });

  it("tolerates Content-Length: 0", async () => {
    installFakeDb();
    const app = buildApp();
    const res = await app.request("/v1/ping", {
      method: "POST",
      headers: { "content-length": "0", "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("tolerates valid JSON with no fields", async () => {
    installFakeDb();
    const app = buildApp();
    const res = await app.request("/v1/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 invalid_json for malformed JSON", async () => {
    const app = buildApp();
    const res = await app.request("/v1/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 400 validation_error with normalized issues for a too-long note", async () => {
    const app = buildApp();
    const tooLong = "x".repeat(281);
    const res = await app.request("/v1/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: tooLong }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody & {
      error: { details: { issues?: Array<{ path: string[]; code: string }> } };
    };
    expect(body.error.code).toBe("validation_error");
    const issues = body.error.details.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues?.[0]?.path).toEqual(["note"]);
  });
});

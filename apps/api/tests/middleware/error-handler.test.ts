/**
 * Verifies the standard error envelope from ARCHITECTURE.md:
 *   { error: { code, message, details } }
 *
 * Mounts the error handler on a fresh Hono app so the test does not import
 * the full app factory (which loads the DB client). This keeps the test
 * hermetic — no DATABASE_URL, no Postgres.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../../src/middleware/error-handler.js";
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "../../src/lib/errors.js";
import type { AppBindings } from "../../src/lib/types.js";

function buildTestApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  return app;
}

describe("error handler", () => {
  it("renders an AppError with its code, message, status, and details", async () => {
    const app = buildTestApp();
    app.get("/boom", () => {
      throw new AppError({
        code: "teapot",
        message: "I am a teapot.",
        status: 418,
        details: { hint: "try coffee" },
      });
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(418);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body).toEqual({
      error: {
        code: "teapot",
        message: "I am a teapot.",
        details: { hint: "try coffee" },
      },
    });
  });

  it("renders a NotFoundError as 404 with the standard envelope", async () => {
    const app = buildTestApp();
    app.get("/missing", () => {
      throw new NotFoundError("Product not found.", { productId: "prod_x" });
    });

    const res = await app.request("/missing");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("renders a ValidationError as 400", async () => {
    const app = buildTestApp();
    app.get("/bad", () => {
      throw new ValidationError("Body is required.");
    });

    const res = await app.request("/bad");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(body.error).toEqual({
      code: "validation_error",
      message: "Body is required.",
      details: {},
    });
  });

  it("hides unexpected errors behind a 500 internal_error response", async () => {
    const app = buildTestApp();
    app.get("/panic", () => {
      throw new Error("a secret implementation detail");
    });

    const res = await app.request("/panic");

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    // Internal details must not leak.
    expect(body.error.message).not.toContain("secret");
  });
});

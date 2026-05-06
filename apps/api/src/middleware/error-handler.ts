/**
 * Top-level error handler. Renders the standard error shape from
 * ARCHITECTURE.md and logs unexpected failures.
 *
 * Wired via `app.onError(...)` rather than as a Koa-style middleware. This
 * lets Hono catch errors thrown deeper in the request pipeline (including
 * from middleware that runs before routes) without each layer having to
 * try/catch.
 *
 * Behaviour:
 *   - `AppError` and subclasses pass through to the client with their own
 *     code, message, and status.
 *   - `ZodError` is normalized via `issuesToDetails()` so the wire shape is
 *     identical to what `ValidationError` callers produce.
 *   - `HTTPException` from Hono is mapped to a generic AppError-shaped body
 *     so clients always see the same envelope.
 *   - Anything else is logged at `error` level and returned as a 500 with
 *     `code: "internal_error"`. Internal details are not leaked.
 *
 * Logging always includes `requestId` (from the context), even when the
 * context-bound logger is missing and we fall back to the root logger. The
 * fallback path matters because errors can be thrown before
 * `requestLogger` runs.
 */
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { AppError, issuesToDetails, type ErrorDetails } from "../lib/errors.js";
import { logger as rootLogger } from "../lib/logger.js";
import type { AppBindings } from "../lib/types.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
  };
}

function buildBody(
  code: string,
  message: string,
  details: ErrorDetails = {},
): ErrorBody {
  return { error: { code, message, details } };
}

export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  const ctx = c as Context<AppBindings>;
  const requestId = ctx.get("requestId");
  const log = ctx.get("logger") ?? rootLogger;

  if (err instanceof AppError) {
    log.warn(
      {
        requestId,
        code: err.code,
        status: err.status,
        details: err.details,
      },
      err.message,
    );
    return c.json(
      buildBody(err.code, err.message, err.details),
      err.status as ContentfulStatusCode,
    );
  }

  if (err instanceof ZodError) {
    const details = issuesToDetails(err.issues);
    log.warn(
      { requestId, code: "validation_error", details },
      "validation failed",
    );
    return c.json(
      buildBody("validation_error", "Request validation failed.", details),
      400,
    );
  }

  if (err instanceof HTTPException) {
    log.warn({ requestId, status: err.status }, err.message);
    return c.json(
      buildBody("http_error", err.message || "Request failed."),
      err.status as ContentfulStatusCode,
    );
  }

  // Anything that gets here is a bug. Log the full error server-side, but do
  // not leak the message or stack to the client.
  log.error({ requestId, err }, "unhandled error");
  return c.json(
    buildBody("internal_error", "An unexpected error occurred."),
    500,
  );
};

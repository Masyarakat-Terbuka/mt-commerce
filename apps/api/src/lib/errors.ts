/**
 * Typed application errors.
 *
 * Every error thrown from a route or service that should produce a known
 * client-facing response extends `AppError`. The error-handler middleware
 * catches these and renders the standard error shape from ARCHITECTURE.md:
 *
 *   {
 *     "error": {
 *       "code": "snake_case_code",
 *       "message": "human readable",
 *       "details": { ... }
 *     }
 *   }
 *
 * Anything that escapes as a non-AppError is treated as an internal error and
 * mapped to a 500 with `code: "internal_error"`. Operational details from
 * unexpected errors are not leaked to the client.
 */

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: ErrorDetails;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    details?: ErrorDetails;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "AppError";
    this.code = args.code;
    this.status = args.status;
    this.details = args.details ?? {};
    if (args.cause !== undefined) {
      // Node 16.9+: pass through to the standard `cause` property.
      (this as { cause?: unknown }).cause = args.cause;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({ code: "validation_error", message, status: 400, details });
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.") {
    super({ code: "unauthorized", message, status: 401 });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super({ code: "forbidden", message, status: 403 });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.", details?: ErrorDetails) {
    super({ code: "not_found", message, status: 404, details });
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super({ code: "conflict", message, status: 409, details });
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests.", details?: ErrorDetails) {
    super({ code: "rate_limited", message, status: 429, details });
    this.name = "RateLimitError";
  }
}

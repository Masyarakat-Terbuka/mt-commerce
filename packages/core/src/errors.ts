/**
 * Error types for `@mt-commerce/core`.
 *
 * These live inside the package so that core helpers do not depend on
 * application-level error machinery (e.g. `apps/api`'s `AppError`). This keeps
 * the dependency arrow pointing one way: apps depend on core, never the
 * reverse.
 */

/**
 * Base error for everything thrown by `@mt-commerce/core`.
 *
 * Carries a stable string `code` (so callers can branch on it without parsing
 * messages) and an optional structured `details` bag for diagnostic context.
 */
export class CoreError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * Thrown when arithmetic or comparison is attempted across two `Money` values
 * with different currency codes.
 *
 * ADR-0007: "Cross-currency arithmetic is forbidden without explicit
 * conversion." Callers must convert one side first, never combine raw amounts.
 */
export class CurrencyMismatchError extends CoreError {
  constructor(left: string, right: string, operation: string) {
    super(
      "currency_mismatch",
      `Cannot ${operation} Money values with different currencies: ${left} vs ${right}`,
      { left, right, operation },
    );
    this.name = "CurrencyMismatchError";
  }
}

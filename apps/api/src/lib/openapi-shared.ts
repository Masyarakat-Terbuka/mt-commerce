/**
 * Shared OpenAPI building blocks.
 *
 * Every module's route file pulls from this file rather than redefining the
 * same error envelope, money shape, translations shape, and pagination shape
 * locally. The end goal is one component per concept in the generated
 * OpenAPI document — clients reading the spec see e.g. `ErrorResponse` once,
 * not five near-identical copies.
 *
 * Validation:
 *   - `defaultValidationHook` is the `defaultHook` every `OpenAPIHono`
 *     instance in the migrated routers passes to its constructor. On a
 *     Zod parse failure it throws the `ZodError` so the standard
 *     `errorHandler` at `app.onError` renders the canonical envelope (the
 *     handler already projects ZodError issues through `issuesToDetails`).
 *     Throwing rather than `c.json(...)`-ing here keeps the error envelope
 *     uniform with hand-thrown `ValidationError`s elsewhere in the code.
 *
 * Component-naming convention:
 *   - Schemas that show up as a response/body type get `.openapi("Name")`
 *     so they appear under `components.schemas` in the spec. Names use
 *     PascalCase. Where two modules need a similar shape (e.g. money),
 *     they reuse the schema exported here so the component is shared.
 */
import type { z as zType } from "zod";
import { z } from "@hono/zod-openapi";
import type { ZodError } from "zod";
import type { Context } from "hono";

// ----------------------------------------------------------------------------
// Standard error envelope
// ----------------------------------------------------------------------------

/**
 * Canonical error response shape. Every 4xx/5xx body in the API matches this
 * regardless of whether it came from `AppError`, `ZodError`, or a generic
 * 500 — the `errorHandler` middleware in `middleware/error-handler.ts` is
 * the single rendering point.
 *
 * Documenting this once and referencing it everywhere keeps the spec lean
 * and matches the runtime contract.
 */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({
        description:
          "Stable, snake_case error code (e.g. `validation_error`, `not_found`, `unauthorized`).",
        example: "validation_error",
      }),
      message: z.string().openapi({
        description: "Human-readable error message; safe to show to end users.",
        example: "Request validation failed.",
      }),
      details: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({
          description:
            "Optional, code-specific structured detail. For `validation_error` this contains an `issues` array.",
        }),
    }),
  })
  .openapi("ErrorResponse");

/**
 * Build the response map entries for the standard error statuses. Each call
 * produces `{ [status]: { content: { 'application/json': { schema } }, description } }`,
 * which the route definitions spread into their `responses` object.
 *
 * Splitting these out (rather than always emitting all of `400/401/403/404/409`)
 * keeps each route's spec honest — a public storefront read endpoint shouldn't
 * advertise a 401 it never returns.
 */
export function errorResponse(description: string) {
  return {
    content: { "application/json": { schema: ErrorResponse } },
    description,
  } as const;
}

// ----------------------------------------------------------------------------
// Money on the wire (ADR-0007)
// ----------------------------------------------------------------------------

/**
 * Money values render as `{ amount: "<decimal-string>", currency: "<ISO>" }`.
 * The decimal string preserves bigint precision through JSON.stringify; the
 * currency is the ISO 4217 three-letter code.
 *
 * This is the wire-shape schema (output side). Input schemas in each module's
 * `types.ts` parse strings/numbers into `bigint` — those stay module-local
 * because they wire into the per-module domain validation rules.
 */
export const MoneyJson = z
  .object({
    amount: z
      .string()
      .regex(/^-?\d+$/)
      .openapi({
        description: "Decimal-string integer amount in the smallest unit of the currency.",
        example: "1500000",
      }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .openapi({
        description: "ISO 4217 three-letter currency code.",
        example: "IDR",
      }),
  })
  .openapi("Money");

// ----------------------------------------------------------------------------
// Translations (ADR-0010)
// ----------------------------------------------------------------------------

/**
 * Translations envelope: a record of `<locale> → <field-map>`. Field-map
 * shapes vary per entity (product, variant, category) so we keep this as the
 * loose container; per-entity input schemas in each module narrow the inner
 * shape with locale and field-length rules.
 */
export const TranslationsJson = z
  .record(z.string(), z.record(z.string(), z.string()))
  .openapi("Translations", {
    description:
      "Locale-keyed translations. Top-level keys are locale codes (e.g. `id`, `en`); inner keys are field names. See ADR-0010.",
  });

// ----------------------------------------------------------------------------
// Pagination
// ----------------------------------------------------------------------------

/**
 * Build a paginated-response schema for any item shape. We do NOT call
 * `.openapi(name)` on the result because the resulting component name would
 * have to vary per call (e.g. `PaginatedProduct`); instead each module names
 * its own paginated wrappers when registering routes. The factory just keeps
 * the field shape consistent.
 */
export function paginated<T extends zType.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    total: z
      .number()
      .int()
      .nonnegative()
      .openapi({ description: "Total matching items across all pages." }),
    page: z.number().int().min(1).openapi({ description: "1-based page index." }),
    pageSize: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Items per page." }),
  });
}

// ----------------------------------------------------------------------------
// Generic empty-list envelope { data: T[] }
// ----------------------------------------------------------------------------

export function listEnvelope<T extends zType.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item) });
}

// ----------------------------------------------------------------------------
// Validation hook
// ----------------------------------------------------------------------------

/**
 * The `defaultHook` every migrated `OpenAPIHono` instance installs.
 *
 * On a Zod parse failure (path/query/header/json), throw the `ZodError` so
 * `errorHandler` at `app.onError` projects it through `issuesToDetails` into
 * the standard `validation_error` envelope. This keeps the contract identical
 * to the legacy hand-rolled `parseOrThrow(...)` behavior the routes used
 * before this migration.
 *
 * Typed loosely (`unknown` data, `Context<any>`) so it can serve as the
 * `defaultHook` for any `OpenAPIHono<E>` regardless of `Env`. The library's
 * `defaultHook` slot is `Hook<any, E, any, any>`, and our hook is generic
 * over those positions.
 */
export function defaultValidationHook(
  result: { success: true; data: unknown } | { success: false; error: ZodError },
  _c: Context,
): void {
  if (!result.success) {
    throw result.error;
  }
}

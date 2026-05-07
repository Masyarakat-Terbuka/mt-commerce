/**
 * `POST /v1/ping` — end-to-end smoke test.
 *
 * Inserts a row into `health_pings` and returns it. Hits the request pipeline,
 * the validation layer, the database, and the response serializer in a single
 * call. Useful in deployment validation and as a copy-paste reference for
 * future routes.
 *
 * Body handling distinguishes three cases so clients get an honest response:
 *   - Empty body or `Content-Length: 0` → tolerate (no payload).
 *   - Valid JSON with no fields → tolerate.
 *   - Malformed JSON → 400 with `code: "invalid_json"` so the client knows the
 *     parse, not the schema, was the problem.
 *
 * The minimal table is intentional — adding a column for `note` would be a
 * real schema change and is out of scope here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import { healthPings } from "../../db/schema/index.js";
import { id } from "@mt-commerce/core/ulid";
import { AppError, ValidationError, issuesToDetails } from "../../lib/errors.js";
import type { AppBindings } from "../../lib/types.js";

const pingBodySchema = z
  .object({
    note: z.string().max(280).optional(),
  })
  .optional();

/**
 * Read and parse the request body. Returns:
 *   - `undefined` when the body is empty / Content-Length is 0 / there is no
 *     content-type indicating JSON (treat as no payload).
 *   - the parsed JSON value when parsing succeeds.
 *
 * Throws `ValidationError("invalid_json")` when a non-empty body fails to
 * parse as JSON, so the caller can distinguish "no payload" from "bad JSON".
 */
async function readOptionalJsonBody(
  req: Request,
): Promise<unknown | undefined> {
  const contentLength = req.headers.get("content-length");
  if (contentLength === "0") return undefined;

  const text = await req.text();
  if (text.length === 0) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Malformed JSON gets its own code so the client can distinguish a parse
    // failure from a schema validation failure (which carries `issues`).
    throw new AppError({
      code: "invalid_json",
      message: "Request body is not valid JSON.",
      status: 400,
    });
  }
}

export function buildPingRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.post("/ping", async (c) => {
    const raw = await readOptionalJsonBody(c.req.raw);
    const parsed = pingBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid ping body.",
        issuesToDetails(parsed.error.issues),
      );
    }

    const pingId = id("ping");
    const [row] = await db
      .insert(healthPings)
      .values({ id: pingId })
      .returning();

    if (!row) {
      // Should never happen with `returning()` on a successful insert; defend
      // against the type regardless.
      throw new Error("Insert returned no rows.");
    }

    return c.json({
      ok: true,
      id: row.id,
      pingedAt: row.pingedAt.toISOString(),
    });
  });

  return router;
}

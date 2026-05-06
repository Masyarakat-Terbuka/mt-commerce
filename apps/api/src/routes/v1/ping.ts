/**
 * `POST /v1/ping` — end-to-end smoke test.
 *
 * Inserts a row into `health_pings` and returns it. Hits the request pipeline,
 * the validation layer, the database, and the response serializer in a single
 * call. Useful in deployment validation and as a copy-paste reference for
 * future routes.
 *
 * The body is optional; if a `note` is provided, it is validated but not
 * stored. The minimal table is intentional — adding a column for `note` would
 * be a real schema change and is out of scope here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import { healthPings } from "../../db/schema/index.js";
import { id } from "../../lib/ulid.js";
import { ValidationError } from "../../lib/errors.js";
import type { AppBindings } from "../../lib/types.js";

const pingBodySchema = z
  .object({
    note: z.string().max(280).optional(),
  })
  .optional();

export function buildPingRoutes(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  router.post("/ping", async (c) => {
    // Body is optional; tolerate missing or empty payloads.
    const raw = await c.req.json().catch(() => undefined);
    const parsed = pingBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid ping body.", {
        issues: parsed.error.issues,
      });
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

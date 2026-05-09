/**
 * dump-openapi — write the running app's OpenAPI document to disk.
 *
 * Used to vendor `apps/docs/public/openapi.json` so the docs site can
 * mount Scalar (or any other OpenAPI viewer) without a live API in
 * front of it. Re-run this whenever the API contract changes:
 *
 *     bun --filter @mt-commerce/api dump:openapi
 *
 * The script builds the same `OpenAPIHono` app the server boots, then
 * fetches `/openapi.json` against it via `app.request(...)` — no HTTP
 * server, no port binding. The OpenAPI document is composed at request
 * time from the `.openapi(...)` route registrations on every nested
 * router, so the output here is exactly what the running API would serve.
 *
 * Writing to a file (not stdout) so the pnpm/bun wrapper warnings and
 * the pino request logger don't contaminate the JSON. Pass a different
 * path with `OPENAPI_OUT=...` if you want to vendor it elsewhere.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../app.js";

const DEFAULT_OUT = resolve(
  import.meta.dir ?? __dirname,
  "../../../docs/public/openapi.json",
);

async function main(): Promise<void> {
  const out = process.env.OPENAPI_OUT
    ? resolve(process.cwd(), process.env.OPENAPI_OUT)
    : DEFAULT_OUT;
  const app = createApp();
  const response = await app.request("/openapi.json");
  if (!response.ok) {
    throw new Error(
      `dump-openapi: request returned ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as unknown;
  // Pretty-print for diff-friendliness in version control. Two-space
  // indent matches the rest of the repo's JSON.
  await writeFile(out, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  console.log(`dump-openapi: wrote ${out}`);
}

void main().catch((err) => {
  console.error("dump-openapi failed:", err);
  process.exit(1);
});

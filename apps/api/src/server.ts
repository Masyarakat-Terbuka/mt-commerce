/**
 * API entry point. Boots the Hono app on `Bun.serve`.
 *
 * Bun.serve is preferred over @hono/node-server here because:
 *   - the runtime is Bun, so there is no portability cost
 *   - one fewer dependency
 *   - `Bun.serve` exposes the running URL via `server.url`, which is handy
 *     for the startup log line
 *
 * If the project ever needs to run under Node (for example, on a hosting
 * platform that does not yet support Bun), swap this file for the equivalent
 * @hono/node-server entry. The app factory does not change.
 */
import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { loadPlugins } from "./lib/plugins.js";

// Plugins load BEFORE the app starts serving so a payment provider, shipping
// provider, or notification channel registered by a plugin is available to
// the very first request. The loader is lenient by default — a misbehaving
// plugin logs and is skipped — and refuses to crash boot unless the
// operator explicitly opts in via MT_COMMERCE_STRICT_PLUGINS=true. See
// `lib/plugins.ts` for the full failure-handling contract.
await loadPlugins();

const app = createApp();

const server = Bun.serve({
  port: env.port,
  fetch: app.fetch,
});

logger.info(
  { port: server.port, env: env.nodeEnv },
  `API listening on :${server.port}`,
);

// Graceful shutdown so in-flight requests get a chance to complete and the
// log buffer flushes cleanly.
const shutdown = (signal: string): void => {
  logger.info({ signal }, "shutting down");
  server.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Structured logger. Single pino instance shared by the whole API.
 *
 * Field conventions (per ARCHITECTURE.md observability section):
 *   - timestamp, level: emitted by pino
 *   - module: name of the subsystem emitting the log
 *   - requestId: ULID assigned by request-id middleware (per request)
 *   - userId: optional, populated when an auth context exists
 *
 * In development, pretty-prints to stdout. In production, emits one JSON
 * object per line for ingestion by the operator's log pipeline.
 */
import pino from "pino";
import { env } from "./env.js";

const baseOptions: pino.LoggerOptions = {
  level: env.logLevel,
  base: undefined, // do not include pid/hostname; deployments add those externally
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger: pino.Logger = env.isDev
  ? pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    })
  : pino(baseOptions);

/**
 * Build a child logger bound to a specific module. Use this at the top of a
 * file: `const log = childLogger("catalog")`.
 */
export function childLogger(module: string): pino.Logger {
  return logger.child({ module });
}

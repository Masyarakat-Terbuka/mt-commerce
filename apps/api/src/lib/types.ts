/**
 * Shared Hono context variables used across middleware and routes.
 *
 * Set typed values via `c.set("requestId", ...)` and read them with
 * `c.get("requestId")`. The `Variables` type is wired into the app factory.
 */
import type { Logger } from "pino";

export interface AppVariables {
  requestId: string;
  logger: Logger;
}

export interface AppBindings {
  Variables: AppVariables;
}

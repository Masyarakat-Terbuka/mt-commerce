/**
 * Per-request locale resolution for catalog routes.
 *
 * Resolution order (per ADR-0010):
 *
 *   1. `?locale=` query parameter.
 *   2. `Accept-Language` header (primary tag only — `en-US` → `en`).
 *   3. `DEFAULT_LOCALE` (`id`).
 *
 * Unknown / malformed values silently coerce to `DEFAULT_LOCALE`. The
 * helper returns a `KnownLocale`, never `null`, so route code can pass it
 * straight to the service without an extra null-check.
 */
import type { Context } from "hono";
import type { AppBindings } from "../../../lib/types.js";
import {
  DEFAULT_LOCALE,
  parseLocale,
  type KnownLocale,
} from "../i18n.js";

export function localeFromRequest(c: Context<AppBindings>): KnownLocale {
  const url = new URL(c.req.url);
  const queryLocale = url.searchParams.get("locale");
  if (queryLocale !== null) {
    // The query param has been *expressed* by the caller. We honor unknown
    // values by silently coercing to the default; that matches how the
    // existing wire layer treats other malformed query inputs (e.g. an
    // unknown sort) and keeps the storefront resilient to typos.
    return parseLocale(queryLocale, DEFAULT_LOCALE);
  }
  const acceptLanguage = c.req.header("accept-language");
  if (acceptLanguage) {
    return parseLocale(acceptLanguage, DEFAULT_LOCALE);
  }
  return DEFAULT_LOCALE;
}

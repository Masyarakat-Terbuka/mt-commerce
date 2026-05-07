/**
 * Locale resolution for translatable catalog content.
 *
 * Per ADR-0010, translatable rows store a `translations` JSONB column keyed
 * by locale code. This module owns the small primitives the rest of the
 * catalog uses:
 *
 *   - `KNOWN_LOCALES` — accepted locale codes for v0.1.
 *   - `DEFAULT_LOCALE` — the locale used when no preference is expressed
 *     and as the first fallback.
 *   - `parseLocale(value)` — coerces an arbitrary string to a member of
 *     `KNOWN_LOCALES`, falling back to the default on unknown input.
 *   - `resolveTranslations(translations, locale)` — flattens the JSONB to
 *     a plain `{ field: string }` object, applying the documented fallback
 *     chain.
 *
 * The resolver returns flat strings (never `null`/`undefined`) so callers
 * downstream can treat translatable fields the same way they treat any
 * other string field. Missing fields collapse to `""` rather than `null`
 * to keep the wire shape stable for SDK consumers; the admin's view of
 * "translation completeness" is the right place to surface gaps, not the
 * shopper-facing wire shape.
 */
import type { Translations } from "../../db/schema/translations.js";

export const KNOWN_LOCALES = ["id", "en"] as const;
export type KnownLocale = (typeof KNOWN_LOCALES)[number];

export const DEFAULT_LOCALE: KnownLocale = "id";

const KNOWN_LOCALE_SET = new Set<string>(KNOWN_LOCALES);

/**
 * Coerce an arbitrary string to a `KnownLocale`. Unknown / malformed values
 * fall back to `fallback` (default: `DEFAULT_LOCALE`). The match is
 * lowercase-insensitive on the primary subtag — `EN`, `en`, `en-US`, and
 * `en-GB` all resolve to `en`.
 */
export function parseLocale(
  value: string | null | undefined,
  fallback: KnownLocale = DEFAULT_LOCALE,
): KnownLocale {
  if (!value) return fallback;
  // Take the primary subtag only; `en-US` → `en`. Trim and lowercase to be
  // forgiving of header/query-string casing.
  const primary = value.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  if (!primary) return fallback;
  const tag = primary.split("-")[0];
  if (tag && KNOWN_LOCALE_SET.has(tag)) {
    return tag as KnownLocale;
  }
  return fallback;
}

/**
 * Pick a single locale's translatable fields out of the JSONB blob,
 * applying the fallback chain documented in ADR-0010:
 *
 *   1. The requested locale's value, when present.
 *   2. The default locale's value (`id`), when present.
 *   3. The first locale's value present on the row, when neither of the
 *      above is set.
 *   4. The empty string when the JSONB is empty.
 *
 * The fallback applies per-field: if the requested locale has `title` but
 * not `description`, we still return the requested-locale `title` and fall
 * back only on `description`.
 */
export function resolveTranslations<F extends string>(
  translations: Translations<F> | null | undefined,
  locale: string,
  defaultLocale: string = DEFAULT_LOCALE,
): Record<F, string> {
  const result = {} as Record<F, string>;
  if (!translations) return result;

  const requested = translations[locale];
  const fallbackToDefault =
    locale === defaultLocale ? undefined : translations[defaultLocale];
  // The "first available" locale is only consulted when neither the
  // requested nor the default has the field. Picking deterministically
  // (alphabetical order) keeps tests stable across runtimes.
  const otherLocales = Object.keys(translations)
    .filter((l) => l !== locale && l !== defaultLocale)
    .sort();

  // Collect the union of all fields seen across locales — we want a
  // complete shape on output, not "only the fields the requested locale
  // happened to have."
  const fieldSet = new Set<F>();
  for (const localeBlob of Object.values(translations)) {
    if (!localeBlob) continue;
    for (const field of Object.keys(localeBlob)) {
      fieldSet.add(field as F);
    }
  }

  for (const field of fieldSet) {
    const fromRequested = requested?.[field];
    if (typeof fromRequested === "string") {
      result[field] = fromRequested;
      continue;
    }
    const fromDefault = fallbackToDefault?.[field];
    if (typeof fromDefault === "string") {
      result[field] = fromDefault;
      continue;
    }
    let foundOther = "";
    for (const other of otherLocales) {
      const candidate = translations[other]?.[field];
      if (typeof candidate === "string") {
        foundOther = candidate;
        break;
      }
    }
    result[field] = foundOther;
  }

  return result;
}

/**
 * Zod refinement-style helper. Validates that a value is a member of
 * `KNOWN_LOCALES` and returns the typed locale. Useful inside Zod schemas
 * that need to surface a precise error message rather than silently
 * coercing to the default.
 */
export function isKnownLocale(value: unknown): value is KnownLocale {
  return typeof value === "string" && KNOWN_LOCALE_SET.has(value);
}

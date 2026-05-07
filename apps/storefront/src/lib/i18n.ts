/**
 * i18n helper.
 *
 * Both Astro components and React islands consume this. Astro pages read
 * `Astro.currentLocale`; React islands receive the locale as a prop because
 * `Astro.*` is server-only.
 *
 * The helper is intentionally a small map lookup. We do not bring in a full
 * i18n runtime (formatjs, i18next) because:
 *   - Strings are flat key/value pairs with no plural rules yet.
 *   - Number/currency formatting goes through `@mt-commerce/core/money`.
 *   - Astro's static build inlines whichever locale a page renders, so we
 *     do not pay for an unused locale per page.
 */
import idStrings from "../i18n/id.json" with { type: "json" };
import enStrings from "../i18n/en.json" with { type: "json" };

export type Locale = "id" | "en";

export const DEFAULT_LOCALE: Locale = "id";
export const SUPPORTED_LOCALES: readonly Locale[] = ["id", "en"] as const;

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  id: idStrings as Record<string, string>,
  en: enStrings as Record<string, string>,
};

export type TranslationKey = keyof typeof idStrings;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(input: string | undefined | null): Locale {
  return isLocale(input) ? input : DEFAULT_LOCALE;
}

/**
 * Returns a translator bound to the given locale. Missing keys fall back to
 * the default locale, then to the key itself, so a missing string is visible
 * but never crashes the page.
 */
export function createTranslator(localeInput: string | undefined | null) {
  const locale = resolveLocale(localeInput);
  const dict = DICTIONARIES[locale];
  const fallback = DICTIONARIES[DEFAULT_LOCALE];

  return function t(key: string): string {
    const value = dict[key] ?? fallback[key];
    return value ?? key;
  };
}

/** The locale's URL prefix. The default locale ("id") is served at "/". */
export function localePath(locale: Locale, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return normalized;
  return `/${locale}${normalized === "/" ? "" : normalized}`;
}

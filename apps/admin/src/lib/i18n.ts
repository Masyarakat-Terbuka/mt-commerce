/**
 * i18n primitives for the admin app — context, hooks, dictionary lookup.
 *
 * The provider component lives in `i18n-provider.tsx` so this module stays
 * pure data + hooks (eslint-plugin-react-refresh requires component-only
 * files for fast-refresh). Most callers only need `useLocale` /
 * `useTranslator` and never touch the provider, so importing through this
 * file remains the common path.
 *
 * Locale resolution: `localStorage` first, then `navigator.language`,
 * defaulting to Bahasa Indonesia. The provider lazy-initializes once, then
 * persists every change back to `localStorage`.
 */
import * as React from "react";
import idStrings from "@/i18n/id.json";
import enStrings from "@/i18n/en.json";

export type Locale = "id" | "en";

export const DEFAULT_LOCALE: Locale = "id";
export const SUPPORTED_LOCALES: readonly Locale[] = ["id", "en"] as const;

export const LOCALE_STORAGE_KEY = "mt.admin.locale";

export const DICTIONARIES: Record<Locale, Record<string, string>> = {
  id: idStrings as Record<string, string>,
  en: enStrings as Record<string, string>,
};

export type TranslationKey = keyof typeof idStrings;

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

function readNavigatorLocale(): Locale | null {
  if (typeof navigator === "undefined") return null;
  const lang = navigator.language?.toLowerCase() ?? "";
  if (lang.startsWith("id")) return "id";
  if (lang.startsWith("en")) return "en";
  return null;
}

function readStoredLocale(): Locale | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
  return isLocale(raw) ? raw : null;
}

export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? readNavigatorLocale() ?? DEFAULT_LOCALE;
}

export interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string) => string;
}

export const LocaleContext = React.createContext<LocaleContextValue | undefined>(
  undefined,
);

export function buildTranslator(locale: Locale): (key: string) => string {
  const dict = DICTIONARIES[locale];
  const fallback = DICTIONARIES[DEFAULT_LOCALE];
  return (key: string) => dict[key] ?? fallback[key] ?? key;
}

export function useLocale(): LocaleContextValue {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used inside a LocaleProvider.");
  }
  return ctx;
}

export function useTranslator(): (key: string) => string {
  return useLocale().t;
}

/**
 * `LocaleProvider` — owns locale state, persists it, and exposes the
 * translator through `LocaleContext`. The hooks live next door in
 * `i18n.ts`; this file is component-only so eslint-plugin-react-refresh is
 * happy.
 */
import * as React from "react";
import {
  LOCALE_STORAGE_KEY,
  LocaleContext,
  buildTranslator,
  resolveInitialLocale,
  type Locale,
  type LocaleContextValue,
} from "@/lib/i18n";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Lazy init avoids reading localStorage on every render. The function form
  // is the React idiom for one-shot derived initial state.
  const [locale, setLocaleState] = React.useState<Locale>(() =>
    resolveInitialLocale(),
  );

  const setLocale = React.useCallback((next: Locale) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
    setLocaleState(next);
  }, []);

  // Memoize the translator so consumers stay stable while only the locale
  // shifts. The closure captures the dictionary lookup so children that read
  // `t` only re-render when the locale actually changes.
  const t = React.useMemo(() => buildTranslator(locale), [locale]);

  // Reflect the active locale on the document for assistive tech and CSS
  // hooks that key off `:lang(...)`. This is a true side-effect on an
  // external system (the DOM), so a useEffect is the correct shape.
  React.useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const value = React.useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

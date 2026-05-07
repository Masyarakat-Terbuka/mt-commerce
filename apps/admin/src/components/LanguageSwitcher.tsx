/**
 * Tiny locale toggle used in the sidebar footer. Two locales today (id, en),
 * so a `Select` would be overkill — a pair of buttons reads as a segmented
 * control and stays readable when the sidebar is collapsed to icons (the
 * whole switcher hides via the sidebar's `group-data-[collapsible=icon]`
 * attribute selectors at the call site).
 */
import { useLocale, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const LABELS: Record<Locale, string> = { id: "ID", en: "EN" };

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();
  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={t("language.label")}
    >
      {(Object.keys(LABELS) as Locale[]).map((code) => {
        const active = code === locale;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLocale(code)}
            aria-pressed={active}
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-[0.6875rem] font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:text-sidebar-foreground",
            )}
          >
            {LABELS[code]}
          </button>
        );
      })}
    </div>
  );
}

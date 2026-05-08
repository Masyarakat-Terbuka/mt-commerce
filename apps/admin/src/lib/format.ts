/**
 * Formatting helpers used across admin screens.
 *
 * `relativeTime` is intentionally locale-aware — the same row displays
 * "2 hari lalu" in Indonesian and "2 days ago" in English without the
 * caller having to branch. We use the platform `Intl.RelativeTimeFormat`
 * rather than pulling in a date library; the resolution is coarse on
 * purpose (per the tier list below).
 */
import { format as formatMoneyCore } from "@mt-commerce/core/money";
import type { Money } from "@mt-commerce/core/money";
import type { Locale } from "@/lib/i18n";

const TIER_SECONDS = [
  { unit: "year" as const, seconds: 60 * 60 * 24 * 365 },
  { unit: "month" as const, seconds: 60 * 60 * 24 * 30 },
  { unit: "week" as const, seconds: 60 * 60 * 24 * 7 },
  { unit: "day" as const, seconds: 60 * 60 * 24 },
  { unit: "hour" as const, seconds: 60 * 60 },
  { unit: "minute" as const, seconds: 60 },
];

const FORMATTER_CACHE = new Map<Locale, Intl.RelativeTimeFormat>();

function getFormatter(locale: Locale): Intl.RelativeTimeFormat {
  let f = FORMATTER_CACHE.get(locale);
  if (f === undefined) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    FORMATTER_CACHE.set(locale, f);
  }
  return f;
}

export function relativeTime(value: Date, locale: Locale): string {
  const now = Date.now();
  const diffSec = Math.round((value.getTime() - now) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) {
    return getFormatter(locale).format(0, "minute");
  }
  for (const tier of TIER_SECONDS) {
    if (absSec >= tier.seconds) {
      const value = Math.round(diffSec / tier.seconds);
      return getFormatter(locale).format(value, tier.unit);
    }
  }
  return value.toLocaleDateString(locale);
}

/**
 * Localize a `Money` value through `@mt-commerce/core/money`'s `format`. The
 * locale string maps from our short admin locale (`id`/`en`) to a BCP-47 tag
 * the core helper expects (`id-ID` / `en-US`). Kept thin on purpose — the
 * core helper handles the bigint→Intl precision boundary.
 */
const MONEY_LOCALE_MAP: Record<Locale, string> = {
  id: "id-ID",
  en: "en-US",
};

export function formatMoney(money: Money, locale: Locale): string {
  return formatMoneyCore(money, { locale: MONEY_LOCALE_MAP[locale] });
}

/**
 * Format an absolute date for display — used where relative time would be
 * misleading (e.g. order placed-at on a customer detail page where the user
 * is reading a record, not glancing at recency). `dateStyle: "medium"` reads
 * as "5 Mei 2026" / "May 5, 2026" without losing the year.
 */
export function absoluteDate(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(MONEY_LOCALE_MAP[locale], {
    dateStyle: "medium",
  }).format(value);
}

export function initialsFromName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
}

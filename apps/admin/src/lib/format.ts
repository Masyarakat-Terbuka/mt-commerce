/**
 * Formatting helpers used across admin screens.
 *
 * `relativeTime` is intentionally locale-aware — the same row displays
 * "2 hari lalu" in Indonesian and "2 days ago" in English without the
 * caller having to branch. We use the platform `Intl.RelativeTimeFormat`
 * rather than pulling in a date library; the resolution is coarse on
 * purpose (per the tier list below).
 */
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

export function initialsFromName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
}

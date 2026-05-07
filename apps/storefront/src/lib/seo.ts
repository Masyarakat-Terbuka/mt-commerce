/**
 * SEO helpers for the storefront.
 *
 * Two concerns live here:
 *
 *  1. Rendering JSON-LD safely. JSON contains literal `<` characters
 *     whenever a value contains a URL with a path segment that starts with
 *     `</...>`, an HTML-shaped string, or a `</script>` substring. Inside a
 *     `<script>` element, the HTML parser does NOT decode entities and a
 *     stray `</script>` will close the script tag and turn the rest of the
 *     payload into HTML. The standard mitigation, recommended by
 *     schema.org and Google, is to escape the `<` in the closing-tag
 *     sequence on the way out. We do that here in one place so callers
 *     (`BaseLayout.astro`) cannot forget.
 *
 *  2. Building hreflang URL pairs for the id/en routing scheme. The
 *     storefront serves the default locale ("id") at `/` and English at
 *     `/en/...`. Every page should advertise both URLs and an `x-default`
 *     so search engines can pick the right one per visitor. See
 *     https://developers.google.com/search/docs/specialized/international/localized-versions
 *
 * No external deps — these are pure helpers, safe to import from `.astro`
 * pages, layouts, and unit tests.
 */
import { DEFAULT_LOCALE, localePath, type Locale } from "./i18n.js";

// Pre-compiled regex for U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
// SEPARATOR). Built with `String.fromCharCode` so the source file holds
// no raw control characters — TypeScript's parser would otherwise
// interpret a literal U+2028/U+2029 inside a regex as a line terminator
// and flag the regex as unterminated.
const LINE_TERM_RE = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/**
 * Stringify a JSON-LD payload for embedding inside a `<script
 * type="application/ld+json">` element.
 *
 * The only character we have to escape is the `<` inside the literal
 * `</script` sequence (and the broader `</` to be safe — script content
 * is parsed in "script data" state where `</` triggers end-tag matching).
 * We escape all `</` to `<\/` because:
 *   - It is invisible inside a JSON string at parse time (the JSON spec
 *     allows `\/` as a synonym for `/`).
 *   - It defends against XSS through user-provided product copy that
 *     might contain a literal `</script>` substring.
 *
 * U+2028 and U+2029 are valid in JSON strings but historically broke
 * older JS parsers when JSON was inlined into a script body. They are
 * kept escaped via Unicode escape sequences here — cheap insurance.
 */
export function jsonLdString(payload: object | object[]): string {
  return JSON.stringify(payload)
    .replace(/<\//g, "<\\/")
    .replace(LINE_TERM_RE, (ch) =>
      ch.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029",
    );
}

/**
 * Strip the locale prefix from a pathname so we can compute the matching
 * URL on the other locale. Examples:
 *   "/"             -> "/"
 *   "/products"     -> "/products"
 *   "/en/"          -> "/"
 *   "/en/products"  -> "/products"
 *
 * Trailing slashes are normalised to a single empty path so callers can
 * concatenate cleanly. We keep this private — `localePath` is the public
 * way to build a URL for a locale.
 */
function stripLocalePrefix(pathname: string): string {
  // Astro routes always start with `/`. Be defensive in case a caller
  // hands us a relative path; treat it as root-anchored.
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  // Match `/<locale>` or `/<locale>/...`. Only non-default locales get a
  // prefix in our routing scheme. A path that lacks a known prefix is
  // already on the default locale.
  const m = normalized.match(/^\/(en)(?:\/(.*))?$/);
  if (!m) return normalized;
  const rest = m[2] ?? "";
  return `/${rest}`;
}

/**
 * Build the absolute URLs for the id/en pair of a given pathname,
 * suitable for `<link rel="alternate" hreflang="..." />` and
 * `og:locale:alternate`.
 *
 * `siteUrl` should come from `Astro.site` (set in `astro.config.mjs`);
 * we accept it as a parameter so this helper is unit-testable without
 * Astro globals.
 */
export function buildHreflangPair(
  pathname: string,
  siteUrl: string,
): { id: string; en: string; xDefault: string } {
  const bare = stripLocalePrefix(pathname);
  const idPath = localePath("id", bare);
  const enPath = localePath("en", bare);

  // `new URL(path, base)` is the safest way to join — it normalises
  // double slashes and trailing-slash differences across hosts.
  const idUrl = new URL(idPath, siteUrl).toString();
  const enUrl = new URL(enPath, siteUrl).toString();

  // `x-default` is the URL Google picks when no other hreflang matches
  // the visitor's locale preferences. Per Google's guidance, the default
  // locale URL is the appropriate choice for that role on this site.
  const xDefault = DEFAULT_LOCALE === "id" ? idUrl : enUrl;
  return { id: idUrl, en: enUrl, xDefault };
}

/**
 * Map a short `Locale` to the `og:locale` value Open Graph expects
 * (BCP47 with an underscore separator). Centralised so the layout and
 * any future structured-data emitters agree.
 */
export function ogLocale(locale: Locale): string {
  return locale === "en" ? "en_US" : "id_ID";
}

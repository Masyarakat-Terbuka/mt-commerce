/**
 * phone — small Indonesian-friendly normalization helpers.
 *
 * The catalog API and Better Auth both expect E.164 (`+<country><digits>`),
 * but Indonesian shoppers overwhelmingly type the local form
 * (`081234567890`). Rejecting the local form forces them to either know the
 * +62 prefix or paste it from somewhere else — friction at exactly the
 * moment we want zero. This module accepts either, normalizes to E.164 on
 * submit, and validates the normalized result against the regex the API
 * already enforces.
 *
 * Scope: Indonesia-only. v0.1 ships to Indonesian customers; once the
 * storefront opens to other regions, this is the file to grow into a
 * proper country-code resolver.
 */

/**
 * Matches an E.164-shaped phone number — leading `+` optional, then a
 * non-zero digit (so `0...` is rejected here), 1-14 digits trail. Same
 * shape as the API's server-side regex; we re-check on the client to
 * give an inline error before the round-trip.
 */
const E164_REGEX = /^\+?[1-9]\d{1,14}$/;

/**
 * Strip whitespace, dashes, and parentheses people commonly paste from
 * messaging apps or contact lists (e.g. "+62 812-3456-7890").
 */
function stripFormatting(input: string): string {
  return input.replace(/[\s\-()]/g, "");
}

/**
 * Normalize a user-entered phone number to E.164 when possible.
 *
 *   "081234567890"      → "+6281234567890"   (Indonesian local form)
 *   "+62 812-3456-7890" → "+6281234567890"   (formatting stripped)
 *   "+6281234567890"    → "+6281234567890"   (already E.164)
 *   "62812345"          → "62812345"         (left alone — no `+`, no `0`,
 *                                             not enough info to assume +62)
 *   ""                  → ""                  (empty stays empty)
 *
 * The function never throws: callers run `isValidE164` on the result if
 * they need a yes/no.
 */
export function normalizePhone(input: string): string {
  const trimmed = stripFormatting(input.trim());
  if (trimmed.length === 0) return "";
  // Indonesian local form: leading 0 → +62. The next digit must be 1-9
  // for E.164; if it's another 0 we leave it alone so the validator
  // surfaces a real error rather than silently producing "+620...".
  if (trimmed.startsWith("0") && trimmed.length > 1 && trimmed[1] !== "0") {
    return `+62${trimmed.slice(1)}`;
  }
  return trimmed;
}

/** True when `phone` already matches the E.164 shape the API requires. */
export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

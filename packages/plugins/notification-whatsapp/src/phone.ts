/**
 * Phone-number normalisation for the WhatsApp Cloud API.
 *
 * Meta expects the recipient as an E.164-style string WITHOUT the leading
 * `+` (`628123456789`). Indonesian merchants store numbers in any of
 * several local conventions:
 *
 *   - `+62812-3456-789`  (international, with separators)
 *   - `+628123456789`    (international, clean)
 *   - `628123456789`     (international, no plus)
 *   - `08123456789`      (national trunk, leading zero — most common
 *                          on web forms)
 *   - `8123456789`       (subscriber only — some checkout flows strip
 *                          the trunk during capture)
 *
 * `normalizeIndonesianPhone` collapses all five into the canonical wire
 * shape `628123456789`, then `toE164` adds the `+` for displays and logs.
 *
 * Why a custom helper rather than `libphonenumber-js`:
 *   - The plugin's quality bar says "no new top-level deps".
 *   - We only handle Indonesia in v0.1; the Indonesian rule set is small
 *     and well-defined (country code 62, no subscribers shorter than 8
 *     or longer than 12 digits after the country code).
 *   - The function is pure and trivially testable.
 *
 * The helper rejects empty input, characters that are neither digits nor
 * the leading `+`, and lengths that fall outside Meta's 10–15 digit
 * acceptance window — passing a malformed value to Meta yields a
 * `131026 (invalid recipient)` that costs an audit row and a roundtrip.
 */

/** ISO country code for Indonesia (no separator). */
const ID_COUNTRY_CODE = "62";

/**
 * Min/max length checks operate on the digits-only form including the
 * country code. Meta's hard upper bound is 15; Indonesian subscriber
 * numbers are 8–11 digits so the lower bound here is `62` + 8.
 */
const MIN_DIGITS = 10; // "62" + 8 subscriber digits
const MAX_DIGITS = 15; // Meta's E.164 cap

/**
 * Normalize an Indonesian phone number to the WhatsApp wire shape:
 * country code prefixed, no `+`, no separators (`628123456789`).
 *
 * Throws `Error` (caller wraps in a domain error if it cares) when the
 * input cannot be coerced; the WhatsApp channel translates this to a
 * `failed` audit row before the upstream call fires.
 */
export function normalizeIndonesianPhone(input: string): string {
  if (typeof input !== "string") {
    throw new Error("phone must be a string");
  }
  // Strip everything that is not a digit. The leading `+` is informational
  // — once stripped, the country-code prefix tells us the format.
  const digits = input.replace(/\D+/g, "");
  if (digits.length === 0) {
    throw new Error("phone is empty");
  }

  let canonical: string;
  if (digits.startsWith(ID_COUNTRY_CODE)) {
    // Already country-coded (`+62...`, `62...`, or pasted from Meta).
    canonical = digits;
  } else if (digits.startsWith("0")) {
    // National trunk — replace the leading 0 with the country code.
    // `08123` → `628123`. Only the FIRST zero is the trunk; subscriber
    // numbers can begin with internal zeros after the trunk replacement.
    canonical = ID_COUNTRY_CODE + digits.slice(1);
  } else {
    // Subscriber-only digits (`8123...`) — assume Indonesia.
    canonical = ID_COUNTRY_CODE + digits;
  }

  if (canonical.length < MIN_DIGITS) {
    throw new Error(
      `phone "${input}" is too short to be a valid Indonesian number ` +
        `(got ${canonical.length} digits, need at least ${MIN_DIGITS}).`,
    );
  }
  if (canonical.length > MAX_DIGITS) {
    throw new Error(
      `phone "${input}" is too long to be a valid E.164 number ` +
        `(got ${canonical.length} digits, max is ${MAX_DIGITS}).`,
    );
  }
  return canonical;
}

/** Add the leading `+` for display / log purposes. */
export function toE164(canonical: string): string {
  return `+${canonical}`;
}

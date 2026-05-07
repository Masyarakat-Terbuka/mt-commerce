/**
 * Money — typed value object for currency amounts.
 *
 * Implements ADR-0007 (`docs/adr/0007-money-as-integers.md`):
 *
 *   - Amounts are stored as `bigint` in the smallest unit of the currency.
 *     For Indonesian Rupiah this is whole rupiah (no minor unit). For US
 *     Dollars and Euros this is cents.
 *   - Arithmetic across currencies is forbidden — callers must convert
 *     explicitly first. Cross-currency operations throw `CurrencyMismatchError`.
 *   - Multiplication by a fractional `number` factor uses banker's rounding
 *     by default, matching the ADR's "rounding rules are documented per case
 *     (banker's rounding by default)".
 *   - JSON serialization renders `bigint` as a decimal string so that values
 *     survive `JSON.stringify` and round-trip without loss of precision.
 */
import { CurrencyMismatchError } from "./errors.js";

export type Money = {
  amount: bigint;
  currency: string;
};

export type MoneyJSON = {
  amount: string;
  currency: string;
};

export type RoundingMode = "halfEven" | "halfUp" | "down";

/**
 * Currencies whose smallest commonly-used unit is the major unit itself
 * (no fractional sub-unit). For these, the `Money.amount` bigint is in
 * whole units and `format` must NOT divide by 100 before handing the
 * value to `Intl.NumberFormat`.
 *
 * This list is intentionally minimal and conservative — it covers the
 * currencies mt-commerce ships with first-class support for. ISO 4217
 * defines minor-unit counts for every currency; for now we hard-code
 * the ones we use. Other currencies fall through to the standard
 * minor-unit-of-2 assumption (cents/centimes/euros etc.).
 */
const MINOR_UNIT_DIGITS: Record<string, number> = {
  IDR: 0,
  JPY: 0,
  KRW: 0,
  VND: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  MYR: 2,
  AUD: 2,
  CAD: 2,
};

/**
 * The set of currency codes mt-commerce currently supports as first-class.
 * This is the same key set as `MINOR_UNIT_DIGITS` and is exported so that
 * other modules (catalog, checkout, etc.) can validate input currency codes
 * without duplicating the list. Treat as the source of truth — adding a
 * currency means a single edit here.
 *
 * Note: this is a subset of ISO 4217 by design. Currencies outside this list
 * may format with the default minor-unit assumption but are not validated
 * for input — open a PR to add them.
 */
export const KNOWN_CURRENCIES: readonly string[] = Object.freeze(
  Object.keys(MINOR_UNIT_DIGITS),
);

const DEFAULT_MINOR_UNITS = 2;

function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency] ?? DEFAULT_MINOR_UNITS;
}

function assertSameCurrency(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency, operation);
  }
}

export function zero(currency: string): Money {
  return { amount: 0n, currency };
}

export function isMoney(value: unknown): value is Money {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { amount?: unknown; currency?: unknown };
  return typeof v.amount === "bigint" && typeof v.currency === "string";
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "add");
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtract");
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negate(money: Money): Money {
  return { amount: -money.amount, currency: money.currency };
}

export function abs(money: Money): Money {
  return { amount: money.amount < 0n ? -money.amount : money.amount, currency: money.currency };
}

export function isZero(money: Money): boolean {
  return money.amount === 0n;
}

export function isPositive(money: Money): boolean {
  return money.amount > 0n;
}

export function isNegative(money: Money): boolean {
  return money.amount < 0n;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, "compare");
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

/**
 * Decompose a finite, non-NaN JS `number` into an exact integer ratio
 * `numerator / denominator` where both are bigints and `denominator` is a
 * power of 10. We do this via the number's decimal string form rather than
 * its binary float bits because multiplications like `0.075 * 100`, viewed
 * through the IEEE-754 lens, are not what callers mean. The string form
 * captures the user's literal intent (the same way `Number.prototype.toString`
 * does — round-trip-safe, shortest decimal).
 */
function toRatio(value: number): { num: bigint; den: bigint } {
  if (!Number.isFinite(value)) {
    throw new TypeError(`multiply factor must be a finite number, got ${value}`);
  }
  // Integers go through the fast path with denominator 1.
  if (Number.isInteger(value)) {
    return { num: BigInt(value), den: 1n };
  }
  const str = value.toString();
  // Handle scientific notation: e.g. 1e-7 -> "1e-7"
  if (str.includes("e") || str.includes("E")) {
    const [mantissa, expPart] = str.split(/[eE]/) as [string, string];
    const exp = Number(expPart);
    const ratio = toRatio(Number(mantissa));
    if (exp >= 0) {
      return { num: ratio.num * 10n ** BigInt(exp), den: ratio.den };
    }
    return { num: ratio.num, den: ratio.den * 10n ** BigInt(-exp) };
  }
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const dot = unsigned.indexOf(".");
  if (dot === -1) {
    const n = BigInt(unsigned);
    return { num: negative ? -n : n, den: 1n };
  }
  const intPart = unsigned.slice(0, dot);
  const fracPart = unsigned.slice(dot + 1);
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt((intPart === "" ? "0" : intPart) + fracPart);
  return { num: negative ? -num : num, den };
}

/**
 * Divide `n / d` (both bigints, d > 0) and round the result according to
 * `mode`. Handles negatives correctly: rounding modes describe the magnitude
 * direction relative to zero or to the nearest even, not the absolute number
 * line direction.
 */
function divideRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (d <= 0n) {
    throw new RangeError("divideRound: denominator must be positive");
  }
  const negative = n < 0n;
  const absN = negative ? -n : n;
  const quotient = absN / d;
  const remainder = absN % d;
  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  let rounded: bigint;
  switch (mode) {
    case "down": {
      // Truncate toward zero — drop the remainder regardless of size.
      rounded = quotient;
      break;
    }
    case "halfUp": {
      // 2 * remainder >= d  <=>  remainder >= d / 2 (handles odd d safely).
      rounded = remainder * 2n >= d ? quotient + 1n : quotient;
      break;
    }
    case "halfEven": {
      const doubled = remainder * 2n;
      if (doubled > d) {
        rounded = quotient + 1n;
      } else if (doubled < d) {
        rounded = quotient;
      } else {
        // Exactly half. Round to the nearest even quotient.
        rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      }
      break;
    }
  }

  return negative ? -rounded : rounded;
}

/**
 * Multiply a `Money` by either an exact `bigint` (no rounding needed) or a
 * fractional `number`. For `number` factors the fractional product is
 * computed with bigint arithmetic and rounded once, at the end, by `mode`.
 *
 * Default rounding is `halfEven` (banker's rounding) per ADR-0007. Banker's
 * rounding minimizes systematic bias across many calculations, which is what
 * an accounting system wants when applying percentages (tax, discount).
 */
export function multiply(
  money: Money,
  factor: number | bigint,
  opts?: { rounding?: RoundingMode },
): Money {
  if (typeof factor === "bigint") {
    return { amount: money.amount * factor, currency: money.currency };
  }
  const mode = opts?.rounding ?? "halfEven";
  const { num, den } = toRatio(factor);
  const product = money.amount * num;
  const rounded = divideRound(product, den, mode);
  return { amount: rounded, currency: money.currency };
}

/**
 * Convert a `Money` value to a localized human-readable string using
 * `Intl.NumberFormat`'s `currency` style. The bigint→Intl boundary requires
 * care:
 *
 *   - For currencies with no minor unit (IDR, JPY, KRW, VND), the bigint
 *     `amount` is already a whole-currency value, so we hand it straight
 *     to Intl as a Number. Common rupiah amounts up to ~9e15 fit safely
 *     inside `Number.MAX_SAFE_INTEGER`, but we still build a string-based
 *     fallback path for amounts that would lose precision when cast.
 *   - For currencies with minor units, we split the bigint into integer and
 *     fractional parts and pass the decimal string to Intl, which parses it
 *     and formats according to the locale's currency rules. This avoids the
 *     `BigInt → Number` precision cliff entirely for large totals.
 *
 * Default locale is `id-ID`, matching mt-commerce's primary audience.
 */
export function format(
  money: Money,
  opts?: { locale?: string; currency?: string },
): string {
  const locale = opts?.locale ?? "id-ID";
  const currency = opts?.currency ?? money.currency;
  const digits = minorUnitDigits(currency);

  const negative = money.amount < 0n;
  const absAmount = negative ? -money.amount : money.amount;

  let decimal: string;
  if (digits === 0) {
    decimal = absAmount.toString();
  } else {
    const divisor = 10n ** BigInt(digits);
    const whole = absAmount / divisor;
    const frac = absAmount % divisor;
    const fracStr = frac.toString().padStart(digits, "0");
    decimal = `${whole.toString()}.${fracStr}`;
  }
  if (negative) decimal = `-${decimal}`;

  // `Intl.NumberFormat` accepts string inputs in modern runtimes (Node 18+,
  // Bun, evergreen browsers). This avoids any `Number(bigint)` precision loss.
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return formatter.format(decimal as unknown as number);
}

export function toJSON(money: Money): MoneyJSON {
  return { amount: money.amount.toString(), currency: money.currency };
}

export function fromJSON(json: MoneyJSON): Money {
  return { amount: BigInt(json.amount), currency: json.currency };
}

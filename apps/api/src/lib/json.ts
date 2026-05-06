/**
 * JSON helpers.
 *
 * The platform stores money as `bigint` (see ADR-0007). `JSON.stringify` does
 * not handle `bigint` natively — without a serializer, `c.json({ amount: 1n })`
 * throws a TypeError at runtime, which surfaces as a 500 to the client.
 *
 * We standardize on the serialization rule from ADR-0007: amounts cross the
 * wire as strings (`"1500000"`). `toJsonSafe(value)` performs this conversion
 * recursively so any response shape can include `bigint` values without
 * special handling at the route layer.
 *
 * Trade-offs considered:
 *   - Overriding `BigInt.prototype.toJSON` globally would also work and would
 *     be transparent to callers, but it mutates a built-in prototype, which
 *     is a global side effect that other libraries can stumble over (most
 *     notably during integration with code that expects native bigint
 *     behavior). A pure helper is more contained and easier to reason about.
 *   - Keeping the helper recursive (rather than relying on `JSON.stringify`'s
 *     replacer) lets the value remain a normal object that callers can pass
 *     through Hono's `c.json()`, which already does its own stringification.
 */

/**
 * Install a global `BigInt.prototype.toJSON` so `JSON.stringify` (and therefore
 * Hono's `c.json()`) emits `bigint` values as decimal strings. This is the
 * standard-path serializer for the API and is wired in `app.ts`.
 *
 * Trade-off: this mutates a built-in prototype, which is a global effect. It
 * is acceptable here because:
 *   1. The behavior matches ADR-0007 (money serializes as a string).
 *   2. The override is idempotent — calling it more than once is harmless.
 *   3. Callers that need a non-string representation can call `toJsonSafe`
 *      directly or convert the value before serialization.
 */
export function installBigIntJsonSerializer(): void {
  // Use a defined property so we can detect prior installation and avoid
  // triggering "already defined" warnings if the module is loaded twice.
  const proto = BigInt.prototype as unknown as {
    toJSON?: () => string;
  };
  if (typeof proto.toJSON === "function") return;
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}

/**
 * Recursively convert a value into a JSON-safe shape, replacing `bigint`
 * values with their decimal string representation. Other values pass through
 * unchanged. Cycles are not detected — assume inputs are tree-shaped.
 */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (typeof value === "object") {
    // Date and similar object types serialize via their own `toJSON`; pass
    // them through unchanged so we do not flatten them into plain objects.
    if (value instanceof Date) return value;

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toJsonSafe(entry);
    }
    return result;
  }
  return value;
}

/**
 * Typed ULID-based identifiers.
 *
 * Every entity in mt-commerce has a string ID with a typed prefix:
 *   prod_01HZX...   product
 *   ord_01HZX...    order
 *   cust_01HZX...   customer
 *
 * The prefix makes logs and debugging easier, and the branded return type
 * prevents accidentally passing one kind of ID where another is expected.
 *
 * IDs are application-generated, never database-generated. This lets the
 * caller use the ID before the row is inserted (for events, logs, idempotency
 * keys) and keeps the database column simple text.
 */
import { ulid } from "ulid";

/**
 * Generate a typed, prefixed ULID.
 *
 * @example
 *   const productId = id("prod"); // "prod_01HZX..."
 *   const orderId = id("ord");    // "ord_01HZX..."
 */
export function id<T extends string>(prefix: T): `${T}_${string}` {
  return `${prefix}_${ulid()}`;
}

/**
 * Generate a raw ULID without a prefix. Use sparingly — most callers should
 * use `id(prefix)` to get a typed identifier.
 */
export function rawUlid(): string {
  return ulid();
}

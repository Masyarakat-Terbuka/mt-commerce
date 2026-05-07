/**
 * Password and API-key hashing helpers.
 *
 * Argon2id is the project commitment (SECURITY.md): memory-hard, GPU-resistant,
 * recommended by OWASP. Better Auth uses Argon2id for the user password hash
 * by default; this file is for the API-key path, which mt-commerce owns
 * directly.
 *
 * Implementation choice: `@node-rs/argon2` is fast (Rust binding), works on
 * Bun, has zero peer dependencies, and is the same library Better Auth
 * recommends in its docs. Using one Argon2 implementation across the codebase
 * keeps the cost story consistent.
 *
 * The default parameters from the library follow OWASP's recommendation:
 *   - memoryCost: 65536  (64 MiB)
 *   - timeCost:   2
 *   - parallelism: 1
 *   - variant:    Argon2id
 *
 * We accept the defaults; if a deployment needs to dial them up for
 * higher-value environments, that is a one-line change with the trade-off
 * being per-request CPU.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

/** Hash a password or secret using Argon2id with library defaults. */
export async function hashSecret(plaintext: string): Promise<string> {
  return argonHash(plaintext);
}

/**
 * Constant-time comparison via the underlying library. Returns false on
 * malformed hashes rather than throwing, so a corrupt DB row never produces
 * a 500 on the auth path.
 */
export async function verifySecret(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await argonVerify(storedHash, plaintext);
  } catch {
    return false;
  }
}

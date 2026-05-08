/**
 * `SettingsService` — public contract for the settings module.
 *
 * Owns:
 *   - lazy initialization of the singleton row on first read so callers
 *     never face a "settings not found" path
 *   - input → row coercion for the partial PATCH
 *   - row → domain mapping (delegated to `mappers.ts`)
 *   - domain errors (NotFoundError) — never leaks Drizzle/Postgres errors
 *
 * Constructor takes a repository so tests can swap an in-memory fake; the
 * default singleton (`settingsService`) is wired to `db`.
 *
 * Concurrency: two simultaneous first-reads can each see `getSingleton() →
 * null`. We rely on the PRIMARY KEY (`id = 'singleton'`) to make at most
 * one insert succeed; the loser catches the unique violation and re-reads.
 * No application-level lock needed — the database is the serialization
 * point.
 */
import {
  NotFoundError,
} from "../../lib/errors.js";
import { toStoreSettings } from "./mappers.js";
import {
  createSettingsRepository,
  SINGLETON_ID,
  type SettingsRepository,
} from "./repository.js";
import type { StoreSettings, UpdateSettingsInput } from "./types.js";

export interface SettingsService {
  /**
   * Read the singleton, lazily inserting the default row on first read.
   * Always returns a `StoreSettings` — never `null`. The lazy-insert
   * keeps the wire contract simple (no "uninitialized" path) without a
   * separate provisioning step in the seed.
   */
  getSettings(): Promise<StoreSettings>;
  /**
   * Apply a partial update. Lazily inserts the default row first if it
   * does not exist, then applies the patch on top. Returns the post-
   * update domain object.
   */
  updateSettings(patch: UpdateSettingsInput): Promise<StoreSettings>;
}

export class SettingsServiceImpl implements SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async getSettings(): Promise<StoreSettings> {
    const row = await this.ensureSingleton();
    return toStoreSettings(row);
  }

  async updateSettings(patch: UpdateSettingsInput): Promise<StoreSettings> {
    // Make sure the row exists before patching. The first PATCH on a
    // fresh database lands on a missing row otherwise.
    await this.ensureSingleton();

    const updated = await this.repo.updateSingleton({
      ...(patch.storeName !== undefined ? { storeName: patch.storeName } : {}),
      ...(patch.defaultCurrency !== undefined
        ? { defaultCurrency: patch.defaultCurrency }
        : {}),
      ...(patch.defaultLocale !== undefined
        ? { defaultLocale: patch.defaultLocale }
        : {}),
      ...(patch.defaultTaxRateId !== undefined
        ? { defaultTaxRateId: patch.defaultTaxRateId }
        : {}),
      ...(patch.shippingOriginProvinsiId !== undefined
        ? { shippingOriginProvinsiId: patch.shippingOriginProvinsiId }
        : {}),
      ...(patch.shippingOriginKotaKabupatenId !== undefined
        ? { shippingOriginKotaKabupatenId: patch.shippingOriginKotaKabupatenId }
        : {}),
      ...(patch.shippingOriginKecamatanId !== undefined
        ? { shippingOriginKecamatanId: patch.shippingOriginKecamatanId }
        : {}),
      ...(patch.shippingOriginKelurahanId !== undefined
        ? { shippingOriginKelurahanId: patch.shippingOriginKelurahanId }
        : {}),
      ...(patch.shippingOriginPostalCode !== undefined
        ? { shippingOriginPostalCode: patch.shippingOriginPostalCode }
        : {}),
      ...(patch.shippingOriginAddressLine1 !== undefined
        ? { shippingOriginAddressLine1: patch.shippingOriginAddressLine1 }
        : {}),
      ...(patch.shippingOriginPhone !== undefined
        ? { shippingOriginPhone: patch.shippingOriginPhone }
        : {}),
      ...(patch.notificationEmailEnabled !== undefined
        ? { notificationEmailEnabled: patch.notificationEmailEnabled }
        : {}),
      ...(patch.notificationWhatsappEnabled !== undefined
        ? { notificationWhatsappEnabled: patch.notificationWhatsappEnabled }
        : {}),
    });
    if (!updated) {
      // Singleton row vanished between the ensure and the update — this
      // can only happen if someone manually deleted the row outside the
      // service. Surface a clear error rather than a silent "no rows".
      throw new NotFoundError("Settings row not found.");
    }

    // Re-read so the PATCH response carries the resolved region NAMES
    // alongside the ids the caller just set. Without this re-read the
    // names would be stale (patch RETURNING does not join).
    return toStoreSettings(await this.repoGetOrThrow());
  }

  /**
   * Read the singleton, inserting the defaults row on first read. The
   * insert is best-effort: if a concurrent caller wins the race, the
   * unique violation is swallowed and we re-read.
   */
  private async ensureSingleton() {
    let existing = await this.repo.getSingleton();
    if (existing) return existing;

    try {
      await this.repo.insertSingleton({
        id: SINGLETON_ID,
        // All other columns carry SQL-side defaults — Drizzle omits them
        // from the INSERT and the database fills in.
      });
    } catch (err) {
      // 23505 = unique_violation. Concurrent first-read won the race; we
      // re-read below.
      if (!isPostgresErrorWithCode(err, "23505")) throw err;
    }

    existing = await this.repo.getSingleton();
    if (!existing) {
      // Should be unreachable: we just inserted (or someone else did) and
      // the PK is the sentinel id. Surface as a hard error rather than
      // looping.
      throw new Error("ensureSingleton: row missing after insert");
    }
    return existing;
  }

  /**
   * Read the singleton or throw. Used after a successful update to
   * compose the response with resolved region names.
   */
  private async repoGetOrThrow() {
    const existing = await this.repo.getSingleton();
    if (!existing) {
      throw new NotFoundError("Settings row not found.");
    }
    return existing;
  }
}

/**
 * Narrow on the postgres-js (and node-postgres) `code` SQLSTATE field. The
 * error type is `unknown` once it bubbles out of a catch block; defensive
 * read keeps the narrow narrow.
 */
function isPostgresErrorWithCode(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = (err as { code?: unknown }).code;
  return candidate === code;
}

/**
 * Default singleton wired to the runtime database. Tests construct
 * `SettingsServiceImpl` directly with a fake repository.
 */
export const settingsService: SettingsService = new SettingsServiceImpl(
  createSettingsRepository(),
);

/**
 * Settings service — unit tests against an in-memory fake repository.
 *
 * The fake mirrors the production semantics that matter for these tests:
 *   - At most one row keyed by `'singleton'`. A second insert throws a
 *     Postgres-style 23505 (the service must catch + re-read).
 *   - The read path returns region NAMES alongside the ids — we model that
 *     by carrying a tiny region table in the fake.
 *
 * What we pin:
 *   - First read lazily inserts the defaults row.
 *   - Concurrent first-reads converge: two callers see the same row and
 *     no exception escapes.
 *   - PATCH is partial — unset keys stay put.
 *   - PATCH that clears a region id (`null`) drops the resolved name from
 *     the response.
 *   - Empty PATCH is rejected at the schema layer (covered by route tests
 *     too, but tested at the schema here).
 */
import { describe, expect, it } from "vitest";
import { SettingsServiceImpl } from "../../../src/modules/settings/service.js";
import type {
  SettingsRepository,
  StoreSettingsRowWithRegions,
} from "../../../src/modules/settings/repository.js";
import { SINGLETON_ID } from "../../../src/modules/settings/repository.js";
import { updateSettingsSchema } from "../../../src/modules/settings/types.js";
import type {
  NewStoreSettingsRow,
  StoreSettingsRow,
} from "../../../src/db/schema/index.js";

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

interface FakeStore {
  row: StoreSettingsRow | null;
  // Region tables are needed because the read path resolves names from ids.
  provinsi: Map<string, string>;
  kotaKabupaten: Map<string, string>;
  kecamatan: Map<string, string>;
  kelurahan: Map<string, string>;
  clock: number;
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

class UniqueViolationError extends Error {
  // postgres-js exposes `code` on the error object.
  code = "23505";
}

function createStore(): FakeStore {
  return {
    row: null,
    provinsi: new Map([["31", "DKI Jakarta"]]),
    kotaKabupaten: new Map([["3171", "Jakarta Selatan"]]),
    kecamatan: new Map([["317101", "Tebet"]]),
    kelurahan: new Map([["3171010001", "Tebet Barat"]]),
    clock: 0,
  };
}

function createFakeRepo(store: FakeStore): SettingsRepository {
  return {
    async getSingleton(): Promise<StoreSettingsRowWithRegions | null> {
      if (!store.row) return null;
      return enrichWithRegions(store);
    },
    async insertSingleton(row: NewStoreSettingsRow): Promise<StoreSettingsRow> {
      // Mirror the PRIMARY KEY (sentinel id) constraint: a second insert
      // raises 23505 so the service can catch + re-read.
      if (store.row) throw new UniqueViolationError("duplicate singleton");
      const now = tick(store);
      const inserted: StoreSettingsRow = {
        id: row.id ?? SINGLETON_ID,
        storeName: row.storeName ?? "mt-commerce",
        defaultCurrency: row.defaultCurrency ?? "IDR",
        defaultLocale: row.defaultLocale ?? "id",
        defaultTaxRateId: row.defaultTaxRateId ?? null,
        shippingOriginProvinsiId: row.shippingOriginProvinsiId ?? null,
        shippingOriginKotaKabupatenId:
          row.shippingOriginKotaKabupatenId ?? null,
        shippingOriginKecamatanId: row.shippingOriginKecamatanId ?? null,
        shippingOriginKelurahanId: row.shippingOriginKelurahanId ?? null,
        shippingOriginPostalCode: row.shippingOriginPostalCode ?? null,
        shippingOriginAddressLine1: row.shippingOriginAddressLine1 ?? null,
        shippingOriginPhone: row.shippingOriginPhone ?? null,
        notificationEmailEnabled: row.notificationEmailEnabled ?? true,
        notificationWhatsappEnabled: row.notificationWhatsappEnabled ?? false,
        createdAt: now,
        updatedAt: now,
      };
      store.row = inserted;
      return inserted;
    },
    async updateSingleton(patch) {
      if (!store.row) return null;
      const merged: StoreSettingsRow = {
        ...store.row,
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
          ? {
              shippingOriginKotaKabupatenId:
                patch.shippingOriginKotaKabupatenId,
            }
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
          ? {
              notificationWhatsappEnabled: patch.notificationWhatsappEnabled,
            }
          : {}),
        updatedAt: tick(store),
      };
      store.row = merged;
      return merged;
    },
  };
}

function enrichWithRegions(store: FakeStore): StoreSettingsRowWithRegions {
  if (!store.row) throw new Error("enrichWithRegions: no row");
  const r = store.row;
  return {
    ...r,
    shippingOriginProvinsiName: r.shippingOriginProvinsiId
      ? store.provinsi.get(r.shippingOriginProvinsiId) ?? null
      : null,
    shippingOriginKotaKabupatenName: r.shippingOriginKotaKabupatenId
      ? store.kotaKabupaten.get(r.shippingOriginKotaKabupatenId) ?? null
      : null,
    shippingOriginKecamatanName: r.shippingOriginKecamatanId
      ? store.kecamatan.get(r.shippingOriginKecamatanId) ?? null
      : null,
    shippingOriginKelurahanName: r.shippingOriginKelurahanId
      ? store.kelurahan.get(r.shippingOriginKelurahanId) ?? null
      : null,
  };
}

function buildService(): {
  service: SettingsServiceImpl;
  store: FakeStore;
} {
  const store = createStore();
  return { service: new SettingsServiceImpl(createFakeRepo(store)), store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettingsService.getSettings", () => {
  it("lazily inserts the defaults on first read", async () => {
    const { service, store } = buildService();
    expect(store.row).toBeNull();
    const s = await service.getSettings();
    expect(s.storeName).toBe("mt-commerce");
    expect(s.defaultCurrency).toBe("IDR");
    expect(s.defaultLocale).toBe("id");
    expect(s.notificationEmailEnabled).toBe(true);
    expect(s.notificationWhatsappEnabled).toBe(false);
    expect(store.row).not.toBeNull();
  });

  it("does not duplicate-insert on subsequent reads", async () => {
    const { service, store } = buildService();
    await service.getSettings();
    const insertedAt = store.row!.createdAt;
    await service.getSettings();
    await service.getSettings();
    // Same row across reads — `createdAt` is the canary.
    expect(store.row!.createdAt).toEqual(insertedAt);
  });

  it("converges when two first-reads race (one wins, the other re-reads)", async () => {
    const { service } = buildService();
    const [a, b] = await Promise.all([
      service.getSettings(),
      service.getSettings(),
    ]);
    expect(a.createdAt).toEqual(b.createdAt);
  });
});

describe("SettingsService.updateSettings", () => {
  it("applies a partial patch and leaves untouched keys alone", async () => {
    const { service } = buildService();
    const before = await service.getSettings();
    expect(before.storeName).toBe("mt-commerce");
    expect(before.notificationWhatsappEnabled).toBe(false);

    const after = await service.updateSettings({
      storeName: "Toko Kopi Gayo",
      notificationWhatsappEnabled: true,
    });
    expect(after.storeName).toBe("Toko Kopi Gayo");
    expect(after.notificationWhatsappEnabled).toBe(true);
    // Defaults preserved.
    expect(after.defaultCurrency).toBe("IDR");
    expect(after.defaultLocale).toBe("id");
    expect(after.notificationEmailEnabled).toBe(true);
  });

  it("embeds resolved region NAMES on the response after a region patch", async () => {
    const { service } = buildService();
    const after = await service.updateSettings({
      shippingOriginProvinsiId: "31",
      shippingOriginKotaKabupatenId: "3171",
      shippingOriginKecamatanId: "317101",
      shippingOriginKelurahanId: "3171010001",
      shippingOriginPostalCode: "12810",
      shippingOriginAddressLine1: "Jl. Sudirman 1",
      shippingOriginPhone: "+6281234567890",
    });
    expect(after.shippingOriginProvinsiName).toBe("DKI Jakarta");
    expect(after.shippingOriginKotaKabupatenName).toBe("Jakarta Selatan");
    expect(after.shippingOriginKecamatanName).toBe("Tebet");
    expect(after.shippingOriginKelurahanName).toBe("Tebet Barat");
  });

  it("clearing a region id (null) drops the resolved name from the response", async () => {
    const { service } = buildService();
    await service.updateSettings({
      shippingOriginProvinsiId: "31",
      shippingOriginKotaKabupatenId: "3171",
      shippingOriginKecamatanId: "317101",
      shippingOriginKelurahanId: "3171010001",
      shippingOriginPostalCode: "12810",
      shippingOriginAddressLine1: "Jl. Sudirman 1",
      shippingOriginPhone: "+6281234567890",
    });
    const cleared = await service.updateSettings({
      shippingOriginKelurahanId: null,
    });
    expect(cleared.shippingOriginKelurahanId).toBeNull();
    expect(cleared.shippingOriginKelurahanName).toBeUndefined();
    // Sibling levels stay populated.
    expect(cleared.shippingOriginProvinsiName).toBe("DKI Jakarta");
  });

  it("works against a fresh database (no preceding read)", async () => {
    const { service, store } = buildService();
    expect(store.row).toBeNull();
    const after = await service.updateSettings({ storeName: "Fresh" });
    expect(after.storeName).toBe("Fresh");
    expect(store.row!.id).toBe(SINGLETON_ID);
  });
});

describe("updateSettingsSchema", () => {
  it("rejects an empty patch with the standard envelope", () => {
    const result = updateSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an unknown locale", () => {
    const result = updateSettingsSchema.safeParse({ defaultLocale: "fr" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed phone", () => {
    const result = updateSettingsSchema.safeParse({
      shippingOriginPhone: "not-a-phone",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a single-field patch", () => {
    const result = updateSettingsSchema.safeParse({
      notificationEmailEnabled: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for nullable optional fields (clear semantics)", () => {
    const result = updateSettingsSchema.safeParse({
      defaultTaxRateId: null,
      shippingOriginPostalCode: null,
    });
    expect(result.success).toBe(true);
  });
});

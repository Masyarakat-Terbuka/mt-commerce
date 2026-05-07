/**
 * Customer service — unit tests against an in-memory fake repository.
 *
 * Same pattern as the catalog tests: construct `CustomerServiceImpl` with a
 * hand-rolled fake that mirrors the real repository shape. Lets us assert
 * domain behavior (email uniqueness, soft-delete visibility, address-tree
 * validation, default-per-kind transitions, region lookups, postal-code
 * search) without standing up a database.
 */
import { describe, expect, it } from "vitest";
import { CustomerServiceImpl } from "../../../src/modules/customer/service.js";
import type { CustomerRepository } from "../../../src/modules/customer/repository.js";
import type {
  CustomerAddressRow,
  CustomerRow,
  KecamatanRow,
  KelurahanRow,
  KotaKabupatenRow,
  NewCustomerAddressRow,
  NewCustomerRow,
  ProvinsiRow,
} from "../../../src/db/schema/index.js";

// ---------------------------------------------------------------------------
// In-memory store + fake repository
// ---------------------------------------------------------------------------

interface FakeStore {
  customers: Map<string, CustomerRow>;
  addresses: Map<string, CustomerAddressRow>;
  provinsi: Map<string, ProvinsiRow>;
  kotaKabupaten: Map<string, KotaKabupatenRow>;
  kecamatan: Map<string, KecamatanRow>;
  kelurahan: Map<string, KelurahanRow>;
}

function createStore(): FakeStore {
  return {
    customers: new Map(),
    addresses: new Map(),
    provinsi: new Map(),
    kotaKabupaten: new Map(),
    kecamatan: new Map(),
    kelurahan: new Map(),
  };
}

const fixedNow = (): Date => new Date("2026-05-07T12:00:00.000Z");

function createFakeRepo(store: FakeStore): CustomerRepository {
  const repo: CustomerRepository = {
    async insertCustomer(row: NewCustomerRow): Promise<CustomerRow> {
      const customer: CustomerRow = {
        id: row.id,
        authUserId: row.authUserId ?? null,
        email: row.email,
        displayName: row.displayName ?? null,
        phone: row.phone ?? null,
        taxIdentifier: row.taxIdentifier ?? null,
        companyName: row.companyName ?? null,
        createdAt: fixedNow(),
        updatedAt: fixedNow(),
        deletedAt: null,
      };
      store.customers.set(customer.id, customer);
      return customer;
    },
    async getCustomerById(id) {
      return store.customers.get(id) ?? null;
    },
    async getCustomerByEmail(email) {
      for (const c of store.customers.values()) {
        if (c.email === email) return c;
      }
      return null;
    },
    async getCustomerByAuthUserId(authUserId) {
      for (const c of store.customers.values()) {
        if (c.authUserId === authUserId) return c;
      }
      return null;
    },
    async listCustomers(filters) {
      let rows = [...store.customers.values()];
      if (filters.excludeDeleted) {
        rows = rows.filter((c) => c.deletedAt === null);
      }
      if (filters.email) {
        rows = rows.filter((c) => c.email === filters.email);
      }
      if (filters.search) {
        const needle = filters.search.toLowerCase();
        rows = rows.filter((c) => c.email.toLowerCase().includes(needle));
      }
      const total = rows.length;
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(start, start + filters.pageSize), total };
    },
    async updateCustomer(id, patch) {
      const existing = store.customers.get(id);
      if (!existing) return null;
      const updated: CustomerRow = {
        ...existing,
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.displayName !== undefined
          ? { displayName: patch.displayName }
          : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.taxIdentifier !== undefined
          ? { taxIdentifier: patch.taxIdentifier }
          : {}),
        ...(patch.companyName !== undefined
          ? { companyName: patch.companyName }
          : {}),
        ...(patch.authUserId !== undefined
          ? { authUserId: patch.authUserId }
          : {}),
        updatedAt: fixedNow(),
      };
      store.customers.set(id, updated);
      return updated;
    },
    async softDeleteCustomer(id) {
      const existing = store.customers.get(id);
      if (!existing) return;
      store.customers.set(id, { ...existing, deletedAt: fixedNow() });
    },

    // Addresses
    async insertAddress(row: NewCustomerAddressRow) {
      const address: CustomerAddressRow = {
        id: row.id,
        customerId: row.customerId,
        kind: row.kind,
        isDefaultShipping: row.isDefaultShipping ?? false,
        isDefaultBilling: row.isDefaultBilling ?? false,
        recipientName: row.recipientName,
        phone: row.phone,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2 ?? null,
        provinsiId: row.provinsiId,
        kotaKabupatenId: row.kotaKabupatenId,
        kecamatanId: row.kecamatanId,
        kelurahanId: row.kelurahanId ?? null,
        postalCode: row.postalCode,
        notes: row.notes ?? null,
        createdAt: fixedNow(),
        updatedAt: fixedNow(),
        deletedAt: null,
      };
      store.addresses.set(address.id, address);
      return address;
    },
    async getAddressById(id) {
      return store.addresses.get(id) ?? null;
    },
    async listAddressesForCustomer(customerId) {
      return [...store.addresses.values()].filter(
        (a) => a.customerId === customerId && a.deletedAt === null,
      );
    },
    async updateAddress(id, patch) {
      const existing = store.addresses.get(id);
      if (!existing) return null;
      const updated: CustomerAddressRow = {
        ...existing,
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.isDefaultShipping !== undefined
          ? { isDefaultShipping: patch.isDefaultShipping }
          : {}),
        ...(patch.isDefaultBilling !== undefined
          ? { isDefaultBilling: patch.isDefaultBilling }
          : {}),
        ...(patch.recipientName !== undefined
          ? { recipientName: patch.recipientName }
          : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.addressLine1 !== undefined
          ? { addressLine1: patch.addressLine1 }
          : {}),
        ...(patch.addressLine2 !== undefined
          ? { addressLine2: patch.addressLine2 }
          : {}),
        ...(patch.provinsiId !== undefined
          ? { provinsiId: patch.provinsiId }
          : {}),
        ...(patch.kotaKabupatenId !== undefined
          ? { kotaKabupatenId: patch.kotaKabupatenId }
          : {}),
        ...(patch.kecamatanId !== undefined
          ? { kecamatanId: patch.kecamatanId }
          : {}),
        ...(patch.kelurahanId !== undefined
          ? { kelurahanId: patch.kelurahanId }
          : {}),
        ...(patch.postalCode !== undefined
          ? { postalCode: patch.postalCode }
          : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: fixedNow(),
      };
      store.addresses.set(id, updated);
      return updated;
    },
    async softDeleteAddress(id) {
      const existing = store.addresses.get(id);
      if (!existing) return;
      store.addresses.set(id, { ...existing, deletedAt: fixedNow() });
    },
    async clearDefaultForKind(customerId, kind) {
      for (const [id, addr] of store.addresses) {
        if (addr.customerId !== customerId) continue;
        if (addr.deletedAt !== null) continue;
        if (kind === "shipping" && addr.isDefaultShipping) {
          store.addresses.set(id, {
            ...addr,
            isDefaultShipping: false,
            updatedAt: fixedNow(),
          });
        } else if (kind === "billing" && addr.isDefaultBilling) {
          store.addresses.set(id, {
            ...addr,
            isDefaultBilling: false,
            updatedAt: fixedNow(),
          });
        }
      }
    },
    async withTransaction(fn) {
      // The fake has no real transactional semantics; calling the callback
      // with `repo` itself is sufficient for testing the service's logic.
      return fn(repo);
    },

    // Regions
    async listProvinsi() {
      return [...store.provinsi.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    async getProvinsiById(id) {
      return store.provinsi.get(id) ?? null;
    },
    async listKotaKabupaten(provinsiId) {
      return [...store.kotaKabupaten.values()]
        .filter((k) => k.provinsiId === provinsiId)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getKotaKabupatenById(id) {
      return store.kotaKabupaten.get(id) ?? null;
    },
    async listKecamatan(kotaKabupatenId) {
      return [...store.kecamatan.values()]
        .filter((k) => k.kotaKabupatenId === kotaKabupatenId)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getKecamatanById(id) {
      return store.kecamatan.get(id) ?? null;
    },
    async listKelurahan(kecamatanId) {
      return [...store.kelurahan.values()]
        .filter((k) => k.kecamatanId === kecamatanId)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getKelurahanById(id) {
      return store.kelurahan.get(id) ?? null;
    },
    async searchKelurahanByPostalCode(postalCode) {
      return [...store.kelurahan.values()]
        .filter((k) => k.postalCode === postalCode)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function seedJakartaTree(store: FakeStore): {
  provinsiId: string;
  kotaKabupatenId: string;
  kecamatanId: string;
  kelurahanId: string;
  postalCode: string;
} {
  const provinsiId = "31"; // DKI Jakarta
  const kotaKabupatenId = "3171"; // Jakarta Pusat
  const kecamatanId = "317101"; // Gambir
  const kelurahanId = "3171011001";
  const postalCode = "10110";

  store.provinsi.set(provinsiId, {
    id: provinsiId,
    name: "DKI Jakarta",
    createdAt: fixedNow(),
  });
  store.kotaKabupaten.set(kotaKabupatenId, {
    id: kotaKabupatenId,
    provinsiId,
    name: "Jakarta Pusat",
    kind: "kota",
    createdAt: fixedNow(),
  });
  store.kecamatan.set(kecamatanId, {
    id: kecamatanId,
    kotaKabupatenId,
    name: "Gambir",
    createdAt: fixedNow(),
  });
  store.kelurahan.set(kelurahanId, {
    id: kelurahanId,
    kecamatanId,
    name: "Gambir",
    postalCode,
    createdAt: fixedNow(),
  });
  return { provinsiId, kotaKabupatenId, kecamatanId, kelurahanId, postalCode };
}

function seedJawaBaratTree(store: FakeStore): {
  provinsiId: string;
  kotaKabupatenId: string;
} {
  const provinsiId = "32"; // Jawa Barat
  const kotaKabupatenId = "3273"; // Bandung
  store.provinsi.set(provinsiId, {
    id: provinsiId,
    name: "Jawa Barat",
    createdAt: fixedNow(),
  });
  store.kotaKabupaten.set(kotaKabupatenId, {
    id: kotaKabupatenId,
    provinsiId,
    name: "Kota Bandung",
    kind: "kota",
    createdAt: fixedNow(),
  });
  return { provinsiId, kotaKabupatenId };
}

function buildService(): {
  service: CustomerServiceImpl;
  store: FakeStore;
} {
  const store = createStore();
  return { service: new CustomerServiceImpl(createFakeRepo(store)), store };
}

const validAddressBody = (region: ReturnType<typeof seedJakartaTree>) => ({
  kind: "shipping" as const,
  recipientName: "Budi Santoso",
  phone: "+628123456789",
  addressLine1: "Jl. Medan Merdeka Utara No. 1",
  provinsiId: region.provinsiId,
  kotaKabupatenId: region.kotaKabupatenId,
  kecamatanId: region.kecamatanId,
  kelurahanId: region.kelurahanId,
  postalCode: region.postalCode,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CustomerService.createCustomer", () => {
  it("returns a Customer with a cust_-prefixed id", async () => {
    const { service } = buildService();
    const customer = await service.createCustomer({
      email: "budi@example.com",
      displayName: "Budi",
    });
    expect(customer.id).toMatch(/^cust_/);
    expect(customer.email).toBe("budi@example.com");
    expect(customer.displayName).toBe("Budi");
    expect(customer.deletedAt).toBeNull();
  });

  it("rejects a duplicate email with ConflictError", async () => {
    const { service } = buildService();
    await service.createCustomer({ email: "dup@example.com" });
    await expect(
      service.createCustomer({ email: "dup@example.com" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("CustomerService.updateCustomer email uniqueness", () => {
  it("rejects when a different customer already owns the new email", async () => {
    const { service } = buildService();
    await service.createCustomer({ email: "a@example.com" });
    const b = await service.createCustomer({ email: "b@example.com" });
    await expect(
      service.updateCustomer(b.id, { email: "a@example.com" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows updating to the same email (no-op)", async () => {
    const { service } = buildService();
    const c = await service.createCustomer({ email: "same@example.com" });
    const updated = await service.updateCustomer(c.id, {
      email: "same@example.com",
      displayName: "Renamed",
    });
    expect(updated.displayName).toBe("Renamed");
  });
});

describe("CustomerService.softDeleteCustomer", () => {
  it("hides the customer from getCustomerById after delete", async () => {
    const { service } = buildService();
    const c = await service.createCustomer({ email: "doomed@example.com" });
    await service.softDeleteCustomer(c.id);
    const after = await service.getCustomerById(c.id);
    expect(after).toBeNull();
  });
});

describe("CustomerService.validateAddress (via createAddress)", () => {
  it("rejects with address_hierarchy_mismatch when kota does not belong to provinsi", async () => {
    const { service, store } = buildService();
    const jakarta = seedJakartaTree(store);
    const { provinsiId: jabarId } = seedJawaBaratTree(store);
    const customer = await service.createCustomer({
      email: "mismatch@example.com",
    });

    await expect(
      service.createAddress(customer.id, {
        ...validAddressBody(jakarta),
        // Jakarta kota under Jawa Barat provinsi — inconsistent.
        provinsiId: jabarId,
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: { code: "address_hierarchy_mismatch" },
    });
  });
});

describe("CustomerService.setDefaultAddress", () => {
  it("clears the previous default for the same kind", async () => {
    const { service, store } = buildService();
    const region = seedJakartaTree(store);
    const customer = await service.createCustomer({
      email: "two-addr@example.com",
    });

    const first = await service.createAddress(customer.id, {
      ...validAddressBody(region),
      isDefaultShipping: true,
    });
    const second = await service.createAddress(customer.id, {
      ...validAddressBody(region),
      recipientName: "Sari",
    });

    expect(first.isDefaultShipping).toBe(true);

    await service.setDefaultAddress(customer.id, second.id, "shipping");

    const refreshedFirst = await service.getAddressById(first.id);
    const refreshedSecond = await service.getAddressById(second.id);
    expect(refreshedFirst?.isDefaultShipping).toBe(false);
    expect(refreshedSecond?.isDefaultShipping).toBe(true);
    // Billing default is independent and untouched.
    expect(refreshedFirst?.isDefaultBilling).toBe(false);
    expect(refreshedSecond?.isDefaultBilling).toBe(false);
  });
});

describe("CustomerService.listKotaKabupaten", () => {
  it("returns only cities under the requested provinsi", async () => {
    const { service, store } = buildService();
    const jakarta = seedJakartaTree(store);
    const jabar = seedJawaBaratTree(store);

    const cities = await service.listKotaKabupaten({
      provinsiId: jakarta.provinsiId,
    });
    expect(cities.map((c) => c.id)).toEqual([jakarta.kotaKabupatenId]);

    const jabarCities = await service.listKotaKabupaten({
      provinsiId: jabar.provinsiId,
    });
    expect(jabarCities.map((c) => c.id)).toEqual([jabar.kotaKabupatenId]);
  });
});

describe("CustomerService.searchPostalCode", () => {
  it("returns every kelurahan that shares the postal code", async () => {
    const { service, store } = buildService();
    const region = seedJakartaTree(store);
    // Add a second kelurahan under the same kecamatan with the same postal
    // code — boundary cases like this are real and must surface as multiple
    // results.
    const otherKelurahanId = "3171011002";
    store.kelurahan.set(otherKelurahanId, {
      id: otherKelurahanId,
      kecamatanId: region.kecamatanId,
      name: "Cideng",
      postalCode: region.postalCode,
      createdAt: fixedNow(),
    });

    const matches = await service.searchPostalCode(region.postalCode);
    const ids = matches.map((m) => m.id).sort();
    expect(ids).toEqual([region.kelurahanId, otherKelurahanId].sort());

    const empty = await service.searchPostalCode("99999");
    expect(empty).toEqual([]);
  });
});

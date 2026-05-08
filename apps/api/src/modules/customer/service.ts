/**
 * `CustomerService` — public contract for the customer module.
 *
 * Owns:
 *   - input → row coercion (via Zod-validated input types from `types.ts`)
 *   - row → domain mapping (delegated to `mappers.ts`)
 *   - cross-row validation that requires a lookup (email uniqueness, address
 *     hierarchy consistency, default-per-kind invariant)
 *   - domain errors (NotFoundError, ConflictError, ValidationError) — never
 *     leaks Drizzle / Postgres errors through to callers
 *
 * Constructor takes a repository so tests can swap an in-memory fake; the
 * default singleton (`customerService`) is wired to `db`.
 */
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import {
  toCity,
  toCustomer,
  toCustomerAddress,
  toCustomerAddressWithRegions,
  toDistrict,
  toProvince,
  toSubdistrict,
} from "./mappers.js";
import {
  createCustomerRepository,
  type CustomerRepository,
} from "./repository.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type AddressKind,
  type City,
  type CreateAddressInput,
  type CreateCustomerInput,
  type Customer,
  type CustomerAddress,
  type District,
  type ListCustomersQuery,
  type Paginated,
  type Province,
  type Subdistrict,
  type UpdateAddressInput,
  type UpdateCustomerInput,
} from "./types.js";

export interface CustomerService {
  // Customers
  createCustomer(input: CreateCustomerInput): Promise<Customer>;
  getCustomerById(id: string): Promise<Customer | null>;
  getCustomerByAuthUserId(authUserId: string): Promise<Customer | null>;
  getCustomerByEmail(email: string): Promise<Customer | null>;
  listCustomers(
    query: ListCustomersQuery & { excludeDeleted?: boolean },
  ): Promise<Paginated<Customer>>;
  updateCustomer(id: string, patch: UpdateCustomerInput): Promise<Customer>;
  softDeleteCustomer(id: string): Promise<void>;

  // Addresses
  /**
   * Fetch a single address by id, regardless of soft-delete state. Returns
   * `null` when the row does not exist. Admin callers use this to resolve
   * the owning `customerId` before calling ownership-scoped mutations.
   */
  getAddressById(addressId: string): Promise<CustomerAddress | null>;
  listAddresses(customerId: string): Promise<CustomerAddress[]>;
  createAddress(
    customerId: string,
    input: CreateAddressInput,
  ): Promise<CustomerAddress>;
  /**
   * Update an existing address. `customerId` scopes ownership: callers (e.g.
   * the storefront's `/me` routes) MUST pass the resolved customer id so the
   * service can refuse cross-tenant updates. Admin callers that need to
   * update an arbitrary address pass the resolved owner id.
   */
  updateAddress(
    addressId: string,
    customerId: string,
    patch: UpdateAddressInput,
  ): Promise<CustomerAddress>;
  /** See `updateAddress` re. `customerId`. */
  deleteAddress(addressId: string, customerId: string): Promise<void>;
  /**
   * Atomically mark an address as the default for the given kind. Clears the
   * previous default for the same (customer, kind) so the partial unique
   * index is satisfied without a transient duplicate.
   */
  setDefaultAddress(
    customerId: string,
    addressId: string,
    kind: AddressKind,
  ): Promise<CustomerAddress>;

  // Region lookups
  listProvinsi(): Promise<Province[]>;
  listKotaKabupaten(args: { provinsiId: string }): Promise<City[]>;
  listKecamatan(args: { kotaKabupatenId: string }): Promise<District[]>;
  listKelurahan(args: { kecamatanId: string }): Promise<Subdistrict[]>;
  searchPostalCode(postalCode: string): Promise<Subdistrict[]>;
}

export class CustomerServiceImpl implements CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  // -------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------

  async createCustomer(input: CreateCustomerInput): Promise<Customer> {
    const existing = await this.repo.getCustomerByEmail(input.email);
    if (existing) {
      throw new ConflictError("A customer with this email already exists.", {
        email: input.email,
      });
    }

    const customerId = id("cust");
    const row = await this.repo.insertCustomer({
      id: customerId,
      email: input.email,
      authUserId: input.authUserId ?? null,
      displayName: input.displayName ?? null,
      phone: input.phone ?? null,
      taxIdentifier: input.taxIdentifier ?? null,
      companyName: input.companyName ?? null,
    });

    return toCustomer(row);
  }

  async getCustomerById(customerId: string): Promise<Customer | null> {
    const row = await this.repo.getCustomerById(customerId);
    if (!row) return null;
    // Hide soft-deleted customers from `getById` reads. Admin callers that
    // need to inspect tombstones can query the repository directly; the
    // service surface treats deleted_at as "gone".
    if (row.deletedAt !== null) return null;
    return toCustomer(row);
  }

  async getCustomerByAuthUserId(authUserId: string): Promise<Customer | null> {
    const row = await this.repo.getCustomerByAuthUserId(authUserId);
    if (!row) return null;
    if (row.deletedAt !== null) return null;
    return toCustomer(row);
  }

  async getCustomerByEmail(email: string): Promise<Customer | null> {
    const row = await this.repo.getCustomerByEmail(email);
    if (!row) return null;
    if (row.deletedAt !== null) return null;
    return toCustomer(row);
  }

  async listCustomers(
    query: ListCustomersQuery & { excludeDeleted?: boolean },
  ): Promise<Paginated<Customer>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const { rows, total } = await this.repo.listCustomers({
      ...(query.email ? { email: query.email } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.excludeDeleted ? { excludeDeleted: true } : {}),
      page,
      pageSize,
    });

    return {
      data: rows.map((row) => toCustomer(row)),
      total,
      page,
      pageSize,
    };
  }

  async updateCustomer(
    customerId: string,
    patch: UpdateCustomerInput,
  ): Promise<Customer> {
    const existing = await this.repo.getCustomerById(customerId);
    if (!existing || existing.deletedAt !== null) {
      throw new NotFoundError("Customer not found.", { customerId });
    }

    if (patch.email && patch.email !== existing.email) {
      const conflict = await this.repo.getCustomerByEmail(patch.email);
      if (conflict && conflict.id !== customerId) {
        throw new ConflictError("A customer with this email already exists.", {
          email: patch.email,
        });
      }
    }

    const updated = await this.repo.updateCustomer(customerId, {
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
    });
    if (!updated) {
      throw new NotFoundError("Customer not found.", { customerId });
    }
    return toCustomer(updated);
  }

  async softDeleteCustomer(customerId: string): Promise<void> {
    const existing = await this.repo.getCustomerById(customerId);
    if (!existing || existing.deletedAt !== null) {
      throw new NotFoundError("Customer not found.", { customerId });
    }
    await this.repo.softDeleteCustomer(customerId);
  }

  // -------------------------------------------------------------------
  // Addresses
  // -------------------------------------------------------------------

  async getAddressById(addressId: string): Promise<CustomerAddress | null> {
    const row = await this.repo.getAddressById(addressId);
    if (!row) return null;
    if (row.deletedAt !== null) return null;
    return toCustomerAddressWithRegions(row);
  }

  async listAddresses(customerId: string): Promise<CustomerAddress[]> {
    const rows = await this.repo.listAddressesForCustomer(customerId);
    return rows.map((row) => toCustomerAddressWithRegions(row));
  }

  async createAddress(
    customerId: string,
    input: CreateAddressInput,
  ): Promise<CustomerAddress> {
    const customer = await this.repo.getCustomerById(customerId);
    if (!customer || customer.deletedAt !== null) {
      throw new NotFoundError("Customer not found.", { customerId });
    }

    await this.validateAddress({
      provinsiId: input.provinsiId,
      kotaKabupatenId: input.kotaKabupatenId,
      kecamatanId: input.kecamatanId,
      kelurahanId: input.kelurahanId ?? null,
    });

    // If the new address is being created as a default, clear the previous
    // one in the same transaction so the partial unique index is satisfied.
    const wantsDefaultShipping = input.isDefaultShipping === true;
    const wantsDefaultBilling = input.isDefaultBilling === true;

    const addressId = id("addr");
    const insert = async (
      repo: CustomerRepository,
    ): Promise<CustomerAddress> => {
      if (wantsDefaultShipping) {
        await repo.clearDefaultForKind(customerId, "shipping");
      }
      if (wantsDefaultBilling) {
        await repo.clearDefaultForKind(customerId, "billing");
      }
      const row = await repo.insertAddress({
        id: addressId,
        customerId,
        kind: input.kind,
        isDefaultShipping: wantsDefaultShipping,
        isDefaultBilling: wantsDefaultBilling,
        recipientName: input.recipientName,
        phone: input.phone,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        provinsiId: input.provinsiId,
        kotaKabupatenId: input.kotaKabupatenId,
        kecamatanId: input.kecamatanId,
        kelurahanId: input.kelurahanId ?? null,
        postalCode: input.postalCode,
        notes: input.notes ?? null,
      });
      return toCustomerAddress(row);
    };

    if (wantsDefaultShipping || wantsDefaultBilling) {
      return this.repo.withTransaction(insert);
    }
    return insert(this.repo);
  }

  async updateAddress(
    addressId: string,
    customerId: string,
    patch: UpdateAddressInput,
  ): Promise<CustomerAddress> {
    const existing = await this.repo.getAddressById(addressId);
    if (!existing || existing.deletedAt !== null) {
      throw new NotFoundError("Address not found.", { addressId });
    }
    if (existing.customerId !== customerId) {
      // Ownership mismatch — surface as 404 rather than 403 so we do not
      // leak the existence of an address belonging to a different customer.
      throw new NotFoundError("Address not found.", { addressId });
    }

    const regionChanged =
      patch.provinsiId !== undefined ||
      patch.kotaKabupatenId !== undefined ||
      patch.kecamatanId !== undefined ||
      patch.kelurahanId !== undefined;

    if (regionChanged) {
      await this.validateAddress({
        provinsiId: patch.provinsiId ?? existing.provinsiId,
        kotaKabupatenId: patch.kotaKabupatenId ?? existing.kotaKabupatenId,
        kecamatanId: patch.kecamatanId ?? existing.kecamatanId,
        kelurahanId:
          patch.kelurahanId !== undefined
            ? patch.kelurahanId
            : existing.kelurahanId ?? null,
      });
    }

    const wantsDefaultShipping =
      patch.isDefaultShipping !== undefined
        ? patch.isDefaultShipping
        : existing.isDefaultShipping;
    const wantsDefaultBilling =
      patch.isDefaultBilling !== undefined
        ? patch.isDefaultBilling
        : existing.isDefaultBilling;

    const promotingToShipping =
      patch.isDefaultShipping === true && !existing.isDefaultShipping;
    const promotingToBilling =
      patch.isDefaultBilling === true && !existing.isDefaultBilling;

    const apply = async (
      repo: CustomerRepository,
    ): Promise<CustomerAddress> => {
      if (promotingToShipping) {
        await repo.clearDefaultForKind(customerId, "shipping");
      }
      if (promotingToBilling) {
        await repo.clearDefaultForKind(customerId, "billing");
      }
      const updated = await repo.updateAddress(addressId, {
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        isDefaultShipping: wantsDefaultShipping,
        isDefaultBilling: wantsDefaultBilling,
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
      });
      if (!updated) {
        throw new NotFoundError("Address not found.", { addressId });
      }
      return toCustomerAddress(updated);
    };

    if (promotingToShipping || promotingToBilling) {
      return this.repo.withTransaction(apply);
    }
    return apply(this.repo);
  }

  async deleteAddress(addressId: string, customerId: string): Promise<void> {
    const existing = await this.repo.getAddressById(addressId);
    if (!existing || existing.deletedAt !== null) {
      throw new NotFoundError("Address not found.", { addressId });
    }
    if (existing.customerId !== customerId) {
      throw new NotFoundError("Address not found.", { addressId });
    }
    await this.repo.softDeleteAddress(addressId);
  }

  async setDefaultAddress(
    customerId: string,
    addressId: string,
    kind: AddressKind,
  ): Promise<CustomerAddress> {
    const existing = await this.repo.getAddressById(addressId);
    if (!existing || existing.deletedAt !== null) {
      throw new NotFoundError("Address not found.", { addressId });
    }
    if (existing.customerId !== customerId) {
      throw new NotFoundError("Address not found.", { addressId });
    }

    return this.repo.withTransaction(async (tx) => {
      // Single-statement clear-then-set inside one tx, in that order. The
      // partial unique index `WHERE is_default_<kind> AND deleted_at IS NULL`
      // sees only the post-statement view at commit time, so this avoids the
      // duplicate-row race a naive update would hit.
      await tx.clearDefaultForKind(customerId, kind);
      const updated = await tx.updateAddress(addressId, {
        ...(kind === "shipping"
          ? { isDefaultShipping: true }
          : { isDefaultBilling: true }),
      });
      if (!updated) {
        throw new NotFoundError("Address not found.", { addressId });
      }
      return toCustomerAddress(updated);
    });
  }

  // -------------------------------------------------------------------
  // Region lookups
  // -------------------------------------------------------------------

  async listProvinsi(): Promise<Province[]> {
    const rows = await this.repo.listProvinsi();
    return rows.map((row) => toProvince(row));
  }

  async listKotaKabupaten({
    provinsiId,
  }: {
    provinsiId: string;
  }): Promise<City[]> {
    const rows = await this.repo.listKotaKabupaten(provinsiId);
    return rows.map((row) => toCity(row));
  }

  async listKecamatan({
    kotaKabupatenId,
  }: {
    kotaKabupatenId: string;
  }): Promise<District[]> {
    const rows = await this.repo.listKecamatan(kotaKabupatenId);
    return rows.map((row) => toDistrict(row));
  }

  async listKelurahan({
    kecamatanId,
  }: {
    kecamatanId: string;
  }): Promise<Subdistrict[]> {
    const rows = await this.repo.listKelurahan(kecamatanId);
    return rows.map((row) => toSubdistrict(row));
  }

  async searchPostalCode(postalCode: string): Promise<Subdistrict[]> {
    const rows = await this.repo.searchKelurahanByPostalCode(postalCode);
    return rows.map((row) => toSubdistrict(row));
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Walks the four-level hierarchy and asserts the user-supplied IDs hang
   * together. Each level must exist AND link to the level above it. A row
   * can satisfy four independent FKs while being internally inconsistent
   * (kelurahan A under kecamatan A under kota A but a customer-supplied
   * provinsi B); the FKs alone do not catch that.
   *
   * Errors with `details.code = "address_hierarchy_mismatch"` and lists the
   * mismatched levels so clients can highlight the offending dropdown.
   */
  private async validateAddress(input: {
    provinsiId: string;
    kotaKabupatenId: string;
    kecamatanId: string;
    kelurahanId: string | null;
  }): Promise<void> {
    const mismatches: Array<{
      level: "provinsi" | "kota_kabupaten" | "kecamatan" | "kelurahan";
      expected: string | null;
      actual: string;
    }> = [];

    const provinsiRow = await this.repo.getProvinsiById(input.provinsiId);
    if (!provinsiRow) {
      throw new ValidationError("Address hierarchy is invalid.", {
        code: "address_hierarchy_mismatch",
        mismatches: [
          { level: "provinsi", expected: null, actual: input.provinsiId },
        ],
      });
    }

    const kotaRow = await this.repo.getKotaKabupatenById(input.kotaKabupatenId);
    if (!kotaRow) {
      throw new ValidationError("Address hierarchy is invalid.", {
        code: "address_hierarchy_mismatch",
        mismatches: [
          {
            level: "kota_kabupaten",
            expected: null,
            actual: input.kotaKabupatenId,
          },
        ],
      });
    }
    if (kotaRow.provinsiId !== input.provinsiId) {
      mismatches.push({
        level: "kota_kabupaten",
        expected: kotaRow.provinsiId,
        actual: input.provinsiId,
      });
    }

    const kecRow = await this.repo.getKecamatanById(input.kecamatanId);
    if (!kecRow) {
      throw new ValidationError("Address hierarchy is invalid.", {
        code: "address_hierarchy_mismatch",
        mismatches: [
          { level: "kecamatan", expected: null, actual: input.kecamatanId },
        ],
      });
    }
    if (kecRow.kotaKabupatenId !== input.kotaKabupatenId) {
      mismatches.push({
        level: "kecamatan",
        expected: kecRow.kotaKabupatenId,
        actual: input.kotaKabupatenId,
      });
    }

    if (input.kelurahanId !== null) {
      const kelRow = await this.repo.getKelurahanById(input.kelurahanId);
      if (!kelRow) {
        throw new ValidationError("Address hierarchy is invalid.", {
          code: "address_hierarchy_mismatch",
          mismatches: [
            { level: "kelurahan", expected: null, actual: input.kelurahanId },
          ],
        });
      }
      if (kelRow.kecamatanId !== input.kecamatanId) {
        mismatches.push({
          level: "kelurahan",
          expected: kelRow.kecamatanId,
          actual: input.kecamatanId,
        });
      }
    }

    if (mismatches.length > 0) {
      throw new ValidationError("Address hierarchy is invalid.", {
        code: "address_hierarchy_mismatch",
        mismatches,
      });
    }
  }
}

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Default singleton wired to the runtime database. Tests construct
 * `CustomerServiceImpl` directly with a fake repository.
 */
export const customerService: CustomerService = new CustomerServiceImpl(
  createCustomerRepository(),
);

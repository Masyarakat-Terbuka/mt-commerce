# Customer module

Owns customer profiles, customer addresses, and the four-level Indonesian
admin region tree (provinsi → kota_kabupaten → kecamatan → kelurahan).
Per ADR-0005, no other module reads or writes these tables directly —
cross-module callers go through `customerService`.

## Schemas

All under `apps/api/src/db/schema/`:

| Table                | Purpose                                                | ID prefix |
| -------------------- | ------------------------------------------------------ | --------- |
| `customers`          | Customer header (email, optional auth link, profile)   | `cust_`   |
| `customer_addresses` | Shipping/billing addresses, default flags, region FKs  | `addr_`   |
| `provinsi`           | Province (BPS code as PK)                              | BPS code  |
| `kota_kabupaten`     | City/regency, FK to provinsi                           | BPS code  |
| `kecamatan`          | District, FK to kota_kabupaten                         | BPS code  |
| `kelurahan`          | Sub-district, FK to kecamatan, carries `postal_code`   | BPS code  |

### Auth FK contract

`customers.auth_user_id` is `text NULL` with **no FK constraint** in the
initial migration. The auth module's `auth_users.id` is text and ULID-shaped;
the FK is intentionally deferred so this module can ship in parallel with
the auth track. A follow-up migration will add:

```sql
ALTER TABLE customers
  ADD CONSTRAINT customers_auth_user_id_auth_users_id_fk
  FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE SET NULL;
```

`ON DELETE SET NULL` because deleting an auth identity should not delete a
customer record (orders are linked to customers, not auth users).

### Default-per-kind invariant

Two partial unique indexes enforce "at most one default shipping address and
at most one default billing address per customer" without requiring a
single-default-per-customer constraint:

```sql
CREATE UNIQUE INDEX customer_addresses_default_shipping_unique
  ON customer_addresses (customer_id)
  WHERE is_default_shipping AND deleted_at IS NULL;

CREATE UNIQUE INDEX customer_addresses_default_billing_unique
  ON customer_addresses (customer_id)
  WHERE is_default_billing AND deleted_at IS NULL;
```

A single address row can be both defaults at once. A soft-deleted row no
longer blocks setting a new default (the `deleted_at IS NULL` predicate).

## Service interface

```ts
import { customerService, type CustomerService } from "./modules/customer";
```

```ts
interface CustomerService {
  // Customers
  createCustomer(input): Promise<Customer>;
  getCustomerById(id): Promise<Customer | null>;
  getCustomerByAuthUserId(authUserId): Promise<Customer | null>;
  getCustomerByEmail(email): Promise<Customer | null>;
  listCustomers(query & { excludeDeleted? }): Promise<Paginated<Customer>>;
  updateCustomer(id, patch): Promise<Customer>;
  softDeleteCustomer(id): Promise<void>;

  // Addresses
  getAddressById(addressId): Promise<CustomerAddress | null>;
  listAddresses(customerId): Promise<CustomerAddress[]>;
  createAddress(customerId, input): Promise<CustomerAddress>;
  updateAddress(addressId, customerId, patch): Promise<CustomerAddress>;
  deleteAddress(addressId, customerId): Promise<void>;
  setDefaultAddress(customerId, addressId, kind): Promise<CustomerAddress>;

  // Region lookups
  listProvinsi(): Promise<Province[]>;
  listKotaKabupaten({ provinsiId }): Promise<City[]>;
  listKecamatan({ kotaKabupatenId }): Promise<District[]>;
  listKelurahan({ kecamatanId }): Promise<Subdistrict[]>;
  searchPostalCode(postalCode): Promise<Subdistrict[]>;
}
```

The `customerId` parameter on address mutations scopes ownership: the
service refuses to update or delete an address whose `customer_id` does not
match. Admin callers pre-resolve the owner via `getAddressById`; storefront
`/me` callers pass the resolved current customer.

## Routes

### Admin (`/admin/v1`) — `// TODO requireRole("owner", "admin", "staff")`

| Method | Path                                  | Purpose                       |
| ------ | ------------------------------------- | ----------------------------- |
| GET    | `/customers`                          | List + filter + paginate      |
| POST   | `/customers`                          | Create                        |
| GET    | `/customers/:id`                      | Detail incl. addresses        |
| PATCH  | `/customers/:id`                      | Update                        |
| DELETE | `/customers/:id`                      | Soft delete                   |
| GET    | `/customers/:id/addresses`            | List addresses for customer   |
| POST   | `/customers/:id/addresses`            | Create address                |
| PATCH  | `/addresses/:addressId`               | Update address                |
| DELETE | `/addresses/:addressId`               | Soft delete address           |

### Storefront (`/storefront/v1`)

| Method | Path                                              | Auth      |
| ------ | ------------------------------------------------- | --------- |
| GET    | `/customer/me`                                    | TODO auth |
| PATCH  | `/customer/me`                                    | TODO auth |
| GET    | `/customer/me/addresses`                          | TODO auth |
| POST   | `/customer/me/addresses`                          | TODO auth |
| PATCH  | `/customer/me/addresses/:id`                      | TODO auth |
| DELETE | `/customer/me/addresses/:id`                      | TODO auth |
| PUT    | `/customer/me/addresses/:id/default`              | TODO auth |
| GET    | `/regions/provinsi`                               | public    |
| GET    | `/regions/kota-kabupaten?provinsiId=...`          | public    |
| GET    | `/regions/kecamatan?kotaKabupatenId=...`          | public    |
| GET    | `/regions/kelurahan?kecamatanId=...`              | public    |
| GET    | `/regions/postal-code/:code`                      | public    |

#### Auth gating — TODO

Both admin and storefront routers skip the auth middleware while the auth
module is on a parallel track. Storefront `/customer/me/*` currently
accepts a stand-in `x-customer-id` request header to identify the caller.
Once auth lands:

- Admin router: enable `requireAuth()` + `requireRole("owner", "admin", "staff")`.
- Storefront `/customer/me/*`: enable `requireAuth()` and replace the
  `x-customer-id` lookup with `c.var.authUser`-driven
  `getCustomerByAuthUserId(authUser.id)`.
- Storefront `/regions/*` stays public.

### Postal-code lookup

`GET /storefront/v1/regions/postal-code/:code` returns **all** kelurahans
that share the given five-digit code (multiple matches are rare but real,
e.g. boundary cases between adjacent kelurahans). Clients building an
autofill UX should present a short picker when the response has more than
one result.

## Address hierarchy validation

The four region FKs guarantee each level exists, but not that the chosen
kota actually belongs to the chosen provinsi (etc.). The service walks the
tree on every create/update and throws a `ValidationError` with
`details.code = "address_hierarchy_mismatch"` listing the offending
levels. Clients can use the `mismatches` array to highlight exactly which
dropdown is wrong:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Address hierarchy is invalid.",
    "details": {
      "code": "address_hierarchy_mismatch",
      "mismatches": [
        { "level": "kota_kabupaten", "expected": "31", "actual": "32" }
      ]
    }
  }
}
```

## Follow-ups (out of scope this round)

- Auth integration: import `requireAuth` / `requireRole` from
  `modules/auth`, drop the `x-customer-id` storefront stand-in header.
- Add the deferred `customers.auth_user_id` FK to `auth_users.id` in a
  follow-up migration.
- Sample regions seed script (a few real BPS rows so dev environments
  have something to autofill against).
- Full BPS regions data import — bulk loader + admin UI for region updates.
- Mapper-level and route-level tests (this round ships only the focused
  service test).
- Tighter postal-code validation against the seeded `kelurahan.postal_code`
  set (catches typos beyond the current 5-digit regex).
- Promote-guest-to-registered flow (set `auth_user_id` on a pre-existing
  customer record matched by email at sign-up time).

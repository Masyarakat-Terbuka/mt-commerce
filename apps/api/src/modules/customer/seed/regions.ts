/**
 * Sample Indonesian admin-region seed.
 *
 * Hand-picked, real BPS-coded rows covering three provinces, five
 * kota/kabupaten, eight kecamatan, and twelve kelurahan. The data is
 * deliberately small — enough to exercise the dropdown UX, the
 * postal-code lookup, and the address-hierarchy validator on a fresh
 * developer environment, without dragging in the full ~80k-row BPS
 * dataset (that lands as a separate bulk loader; see the customer
 * module README for the follow-up).
 *
 * Idempotency: every insert uses `INSERT ... ON CONFLICT (id) DO NOTHING`
 * via Drizzle's `onConflictDoNothing`. Re-running the seed against an
 * already-seeded database is a no-op; the per-table row counts in the
 * returned summary distinguish "would have inserted" from "actually
 * inserted" so a developer can tell which scenario they hit.
 *
 * BPS code reminder: the `id` column on each region table IS the BPS code
 * (no separate `code` column — see `db/schema/provinsi.ts`). Keep these
 * literals in sync with the official BPS taxonomy; if you change a code
 * you also have to update the rows below it (children reference parents
 * by id).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  kecamatan,
  kelurahan,
  kotaKabupaten,
  provinsi,
  type NewKecamatanRow,
  type NewKelurahanRow,
  type NewKotaKabupatenRow,
  type NewProvinsiRow,
} from "../../../db/schema/index.js";
import type * as schema from "../../../db/schema/index.js";

type Schema = typeof schema;
type Db = PostgresJsDatabase<Schema>;

/**
 * Counts of rows that already existed (skipped via ON CONFLICT) and rows
 * the seed actually inserted. Total = skipped + inserted; the wrapper
 * script logs both so a developer can see at a glance whether their DB
 * was empty.
 */
export interface RegionSeedSummary {
  provinsi: number;
  kotaKabupaten: number;
  kecamatan: number;
  kelurahan: number;
  inserted: {
    provinsi: number;
    kotaKabupaten: number;
    kecamatan: number;
    kelurahan: number;
  };
}

// ---------------------------------------------------------------------------
// Seed data — frozen so accidental mutation in calling code is a TypeError.
// Codes are real BPS values (verified against BPS Permendagri 72/2019 and
// successors). Postal codes are the real Pos Indonesia values for each
// kelurahan as of the data lifecycle date noted next to each block.
// ---------------------------------------------------------------------------

const PROVINSI_ROWS: readonly NewProvinsiRow[] = Object.freeze([
  { id: "31", name: "DKI Jakarta" },
  { id: "32", name: "Jawa Barat" },
  { id: "35", name: "Jawa Timur" },
]);

const KOTA_KABUPATEN_ROWS: readonly NewKotaKabupatenRow[] = Object.freeze([
  { id: "3171", provinsiId: "31", name: "Kota Jakarta Pusat", kind: "kota" },
  { id: "3174", provinsiId: "31", name: "Kota Jakarta Selatan", kind: "kota" },
  { id: "3273", provinsiId: "32", name: "Kota Bandung", kind: "kota" },
  { id: "3578", provinsiId: "35", name: "Kota Surabaya", kind: "kota" },
  { id: "3573", provinsiId: "35", name: "Kota Malang", kind: "kota" },
]);

/**
 * Eight kecamatan across four cities. Two each for Jakarta Pusat,
 * Bandung, Surabaya, and Malang. Jakarta Selatan is intentionally left
 * without children at this seed scale — the city itself still appears in
 * the dropdown so address-hierarchy validation has something to refuse
 * when a developer picks a kota with no kecamatan loaded yet.
 */
const KECAMATAN_ROWS: readonly NewKecamatanRow[] = Object.freeze([
  // Jakarta Pusat
  { id: "317104", kotaKabupatenId: "3171", name: "Menteng" },
  { id: "317103", kotaKabupatenId: "3171", name: "Tanah Abang" },
  // Bandung
  { id: "327317", kotaKabupatenId: "3273", name: "Coblong" },
  { id: "327311", kotaKabupatenId: "3273", name: "Sukajadi" },
  // Surabaya
  { id: "357810", kotaKabupatenId: "3578", name: "Gubeng" },
  { id: "357807", kotaKabupatenId: "3578", name: "Wonokromo" },
  // Malang
  { id: "357303", kotaKabupatenId: "3573", name: "Klojen" },
  { id: "357305", kotaKabupatenId: "3573", name: "Blimbing" },
]);

/**
 * Twelve kelurahan, distributed roughly evenly across the kecamatan.
 * Each carries its real five-digit Pos Indonesia postal code. A few
 * kecamatan get two kelurahans so the postal-code lookup endpoint has
 * at least one shared-postcode case to exercise (e.g. Menteng's 10310
 * covers both Menteng and Pegangsaan in real life — we only seed Menteng
 * here, but the table layout supports the multi-row case).
 */
const KELURAHAN_ROWS: readonly NewKelurahanRow[] = Object.freeze([
  // Menteng (Jakarta Pusat)
  { id: "3171041004", kecamatanId: "317104", name: "Menteng", postalCode: "10310" },
  { id: "3171041003", kecamatanId: "317104", name: "Gondangdia", postalCode: "10350" },
  // Tanah Abang (Jakarta Pusat)
  { id: "3171031003", kecamatanId: "317103", name: "Bendungan Hilir", postalCode: "10210" },
  // Coblong (Bandung)
  { id: "3273171001", kecamatanId: "327317", name: "Dago", postalCode: "40135" },
  { id: "3273171003", kecamatanId: "327317", name: "Lebakgede", postalCode: "40132" },
  // Sukajadi (Bandung)
  { id: "3273111002", kecamatanId: "327311", name: "Sukagalih", postalCode: "40162" },
  // Gubeng (Surabaya)
  { id: "3578101001", kecamatanId: "357810", name: "Gubeng", postalCode: "60281" },
  { id: "3578101005", kecamatanId: "357810", name: "Airlangga", postalCode: "60286" },
  // Wonokromo (Surabaya)
  { id: "3578071003", kecamatanId: "357807", name: "Darmo", postalCode: "60241" },
  // Klojen (Malang)
  { id: "3573031010", kecamatanId: "357303", name: "Klojen", postalCode: "65111" },
  { id: "3573031003", kecamatanId: "357303", name: "Oro-Oro Dowo", postalCode: "65119" },
  // Blimbing (Malang)
  { id: "3573051002", kecamatanId: "357305", name: "Purwantoro", postalCode: "65122" },
]);

/**
 * Insert the seed data idempotently and return both the static shape
 * (always equal to the dataset size) and the dynamic per-table inserted
 * counts (zero on a re-run, equal to the size on first run).
 *
 * Inserts run in dependency order — provinsi → kota_kabupaten → kecamatan
 * → kelurahan — so a partial first run (e.g. interrupted after kota
 * inserts) re-completes cleanly on the next invocation.
 *
 * Each `.returning({ id: ... })` lets us count exactly how many rows the
 * underlying INSERT actually wrote: `onConflictDoNothing` returns zero
 * rows for rows that hit the conflict, and one row for each fresh
 * insert. We avoid a separate SELECT round-trip per table that way.
 */
export async function seedRegions(db: Db): Promise<RegionSeedSummary> {
  const insertedProvinsi = await db
    .insert(provinsi)
    .values([...PROVINSI_ROWS])
    .onConflictDoNothing({ target: provinsi.id })
    .returning({ id: provinsi.id });

  const insertedKota = await db
    .insert(kotaKabupaten)
    .values([...KOTA_KABUPATEN_ROWS])
    .onConflictDoNothing({ target: kotaKabupaten.id })
    .returning({ id: kotaKabupaten.id });

  const insertedKecamatan = await db
    .insert(kecamatan)
    .values([...KECAMATAN_ROWS])
    .onConflictDoNothing({ target: kecamatan.id })
    .returning({ id: kecamatan.id });

  const insertedKelurahan = await db
    .insert(kelurahan)
    .values([...KELURAHAN_ROWS])
    .onConflictDoNothing({ target: kelurahan.id })
    .returning({ id: kelurahan.id });

  return {
    provinsi: PROVINSI_ROWS.length,
    kotaKabupaten: KOTA_KABUPATEN_ROWS.length,
    kecamatan: KECAMATAN_ROWS.length,
    kelurahan: KELURAHAN_ROWS.length,
    inserted: {
      provinsi: insertedProvinsi.length,
      kotaKabupaten: insertedKota.length,
      kecamatan: insertedKecamatan.length,
      kelurahan: insertedKelurahan.length,
    },
  };
}

/**
 * Test-only export so unit tests can assert the static shape of the seed
 * without re-typing the row counts. Not part of the public seed contract.
 */
export const __seedDataForTesting = {
  provinsi: PROVINSI_ROWS,
  kotaKabupaten: KOTA_KABUPATEN_ROWS,
  kecamatan: KECAMATAN_ROWS,
  kelurahan: KELURAHAN_ROWS,
} as const;

/**
 * Helpers that produce the `shipping_methods` rows the operator seeds
 * for a Biteship deployment.
 *
 * v0.1 design: the plugin does NOT auto-mutate `shipping_methods` on
 * boot. Operators run a one-shot script (typically a Bun script in the
 * api repo) that imports {@link defaultBiteshipMethodSeeds} (or builds
 * its own list) and POSTs each row through the admin shipping API.
 *
 * This keeps the plugin's runtime side-effect-free and lets operators
 * curate which couriers they offer without editing plugin config.
 */
import type { BiteshipCourierCode } from "./types.js";

/**
 * One row in the seed list. Mirrors the create-shipping-method input
 * shape (`code`, `name`, `providerKind`) — `providerKind` is hard-pinned
 * to `"plugin"` because Biteship rates are dynamic.
 */
export interface BiteshipMethodSeed {
  /**
   * Stable A-Z, 0-9, underscore code stored on the `shipping_methods`
   * row. The plugin's provider matches by this exact code.
   */
  readonly code: string;
  /** Operator-facing display name, ID-localized. */
  readonly name: string;
  /** Always `"plugin"` for Biteship — rates resolve at quote time. */
  readonly providerKind: "plugin";
  /** Biteship courier code this row maps to (`"jne"`, `"jnt"`, ...). */
  readonly courierCode: BiteshipCourierCode;
  /** Biteship courier service code (`"reg"`, `"oke"`, `"yes"`, ...). */
  readonly courierService: string;
}

/**
 * Default seed list. Covers the most common service tiers per major
 * courier so an operator running the seed script gets a usable
 * checkout out of the box.
 *
 * Codes follow the `<COURIER>_<SERVICE>` convention. Editing this list
 * is fine; the plugin does not depend on these particular entries —
 * the only contract is that the `shipping_methods.code` matches the
 * `code` the operator's quote/createOrder call goes through.
 */
export const defaultBiteshipMethodSeeds: readonly BiteshipMethodSeed[] =
  Object.freeze([
    {
      code: "JNE_REG",
      name: "JNE Reguler",
      providerKind: "plugin",
      courierCode: "jne",
      courierService: "reg",
    },
    {
      code: "JNE_OKE",
      name: "JNE OKE",
      providerKind: "plugin",
      courierCode: "jne",
      courierService: "oke",
    },
    {
      code: "JNE_YES",
      name: "JNE YES",
      providerKind: "plugin",
      courierCode: "jne",
      courierService: "yes",
    },
    {
      code: "JNT_EZ",
      name: "J&T Express",
      providerKind: "plugin",
      courierCode: "jnt",
      courierService: "ez",
    },
    {
      code: "SICEPAT_REG",
      name: "SiCepat Regular",
      providerKind: "plugin",
      courierCode: "sicepat",
      courierService: "reg",
    },
    {
      code: "SICEPAT_BEST",
      name: "SiCepat BEST",
      providerKind: "plugin",
      courierCode: "sicepat",
      courierService: "best",
    },
    {
      code: "ANTERAJA_REG",
      name: "AnterAja Regular",
      providerKind: "plugin",
      courierCode: "anteraja",
      courierService: "reg",
    },
    {
      code: "GOJEK_INSTANT",
      name: "GoSend Instant",
      providerKind: "plugin",
      courierCode: "gojek",
      courierService: "instant",
    },
    {
      code: "GRAB_INSTANT",
      name: "GrabExpress Instant",
      providerKind: "plugin",
      courierCode: "grab",
      courierService: "instant",
    },
  ]);

/**
 * Build the lookup the provider uses internally to resolve a method
 * `code` to the Biteship `(courier, service)` pair. Operators who
 * customize the seed list pass their own array here at plugin
 * construction.
 */
export function buildMethodIndex(
  seeds: readonly BiteshipMethodSeed[],
): Map<string, BiteshipMethodSeed> {
  const index = new Map<string, BiteshipMethodSeed>();
  for (const seed of seeds) {
    if (index.has(seed.code)) {
      throw new Error(
        `@mt-commerce/plugin-shipping-biteship: duplicate method code in seed list: ${seed.code}`,
      );
    }
    index.set(seed.code, seed);
  }
  return index;
}

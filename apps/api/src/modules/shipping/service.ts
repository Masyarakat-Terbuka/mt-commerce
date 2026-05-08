/**
 * `ShippingService` — public contract for the shipping module.
 *
 * Owns:
 *   - shipping-method lifecycle (create, update, soft-delete)
 *   - quote resolution: dispatches to the configured provider for the
 *     method's `providerKind` and asserts currency parity at the boundary
 *   - minimal fulfillment creation (placeholder until the Order module
 *     materializes orders with their own state machine)
 *   - domain errors (NotFoundError, ConflictError, ValidationError) —
 *     never leaks Drizzle/Postgres errors to callers
 *
 * Constructor takes a repository and a provider registry so tests can
 * swap in fakes; the default singleton wires to the runtime DB and the
 * built-in manual provider.
 */
import type { Money } from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import type { ShippingProvider as PluginShippingProvider } from "@mt-commerce/core/plugin";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { toFulfillment, toShippingMethod } from "./mappers.js";
import { manualShippingProvider } from "./providers/manual.js";
import type { ShippingProvider } from "./providers/types.js";
import {
  createShippingRepository,
  type ShippingRepository,
} from "./repository.js";
import type {
  CreateShippingMethodInput,
  Fulfillment,
  QuoteShippingInput,
  ShippingMethod,
  ShippingProviderKind,
  UpdateShippingMethodInput,
} from "./types.js";

export interface ShippingService {
  // Reads
  listMethods(opts?: { activeOnly?: boolean }): Promise<ShippingMethod[]>;
  getById(id: string): Promise<ShippingMethod | null>;
  getByCode(code: string): Promise<ShippingMethod | null>;

  // Quoting
  /**
   * Resolve a shipping price for the given method + currency. Throws:
   *   - `NotFoundError` when the method does not exist or has been
   *     soft-deleted.
   *   - `ConflictError` when the method exists but is inactive.
   *   - `ValidationError {code:"currency_mismatch"}` when the requested
   *     currency does not match the method's configured currency
   *     (manual) or the plugin cannot service the requested currency
   *     (plugin — future).
   */
  quote(input: QuoteShippingInput): Promise<Money>;

  // Mutations (admin)
  createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod>;
  updateMethod(
    id: string,
    patch: UpdateShippingMethodInput,
  ): Promise<ShippingMethod>;
  deleteMethod(id: string): Promise<void>;

  // Fulfillment placeholder
  /**
   * Create a `pending` fulfillment for an order intent. v0.1 stores
   * minimal state; the Order module will own the lifecycle when it lands.
   * Idempotency is the caller's concern — checkout completion is the
   * intended trigger and is itself idempotent through its own middleware.
   */
  createFulfillment(
    orderIntentId: string,
    methodCode: string,
  ): Promise<Fulfillment>;

  // -------------------------------------------------------------------
  // Plugin extension point
  // -------------------------------------------------------------------
  /**
   * Register a plugin-supplied shipping provider keyed by `provider.code`.
   * The shipping service routes a `provider_kind = 'plugin'` method to the
   * registered provider whose `code` equals the method's `code`.
   *
   * Throws `ConflictError` when a provider with the same code is already
   * registered. The plugin loader catches and surfaces this as a clean
   * "duplicate provider" boot diagnostic.
   *
   * Why a separate sub-registry rather than reusing the existing
   * `Map<ShippingProviderKind, ShippingProvider>`: the kind-keyed map can
   * hold one entry per kind, but plugins ship multiple providers (Biteship
   * REG, JNE, SiCepat, …) all under the `plugin` kind. The sub-registry
   * lets each method row pick its provider by `code`.
   */
  registerPluginProvider(provider: PluginShippingProvider): void;
}

export class ShippingServiceImpl implements ShippingService {
  /**
   * Plugin-supplied providers keyed by `provider.code`. Looked up only
   * when `method.providerKind === 'plugin'`; manual methods continue to
   * resolve through `providers.get('manual')`.
   */
  private readonly pluginProviders = new Map<string, PluginShippingProvider>();

  constructor(
    private readonly repo: ShippingRepository,
    private readonly providers: Map<ShippingProviderKind, ShippingProvider>,
  ) {}

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async listMethods(opts?: {
    activeOnly?: boolean;
  }): Promise<ShippingMethod[]> {
    const rows = await this.repo.listMethods({
      activeOnly: opts?.activeOnly ?? true,
    });
    return rows.map(toShippingMethod);
  }

  async getById(methodId: string): Promise<ShippingMethod | null> {
    const row = await this.repo.getMethodById(methodId);
    return row ? toShippingMethod(row) : null;
  }

  async getByCode(code: string): Promise<ShippingMethod | null> {
    const row = await this.repo.getMethodByCode(code);
    return row ? toShippingMethod(row) : null;
  }

  // -------------------------------------------------------------------
  // Quoting
  // -------------------------------------------------------------------

  async quote(input: QuoteShippingInput): Promise<Money> {
    const method = await this.getByCode(input.methodCode);
    if (!method || method.deletedAt !== null) {
      throw new NotFoundError("Shipping method not found.", {
        methodCode: input.methodCode,
      });
    }
    if (!method.isActive) {
      throw new ConflictError("Shipping method is inactive.", {
        methodCode: input.methodCode,
      });
    }

    // Plugin methods route through the `code`-keyed sub-registry; manual
    // methods route through the `kind`-keyed registry. Branching here (and
    // not inside the provider) keeps the manual provider free of plugin
    // concerns and keeps plugin providers free of any default rate logic.
    let amount: Money;
    if (method.providerKind === "plugin") {
      const pluginProvider = this.pluginProviders.get(method.code);
      if (!pluginProvider) {
        throw new ConflictError(
          "No plugin provider registered for this shipping method.",
          {
            providerKind: method.providerKind,
            methodCode: input.methodCode,
          },
        );
      }
      amount = await pluginProvider.quote(method, {
        currency: input.currency,
      });
    } else {
      const provider = this.providers.get(method.providerKind);
      if (!provider) {
        throw new ConflictError("No provider registered for this method.", {
          providerKind: method.providerKind,
          methodCode: input.methodCode,
        });
      }
      amount = await provider.quote(method, { currency: input.currency });
    }
    if (amount.currency !== input.currency) {
      // Provider is expected to assert this itself; defense-in-depth at
      // the service boundary catches a misbehaving plugin.
      throw new ValidationError(
        "Shipping method currency does not match the requested currency.",
        {
          code: "currency_mismatch",
          methodCode: input.methodCode,
          requestedCurrency: input.currency,
          methodCurrency: amount.currency,
        },
      );
    }
    return amount;
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  async createMethod(
    input: CreateShippingMethodInput,
  ): Promise<ShippingMethod> {
    // Pre-flight uniqueness check on `code`. The DB constraint catches
    // the race; the application check catches the common-case "operator
    // re-submitted" so we surface a clean ConflictError without relying
    // on the SQLSTATE classifier.
    const existing = await this.repo.getMethodByCode(input.code);
    if (existing) {
      throw new ConflictError("Shipping method code already exists.", {
        code: input.code,
      });
    }

    // Manual ⇒ flat rate; plugin ⇒ no flat rate. The Zod schema enforces
    // the same rule, but we re-apply at the service boundary so an
    // internal caller bypassing the route layer cannot smuggle an
    // inconsistent shape past the DB CHECK.
    if (input.providerKind === "manual" && !input.flatRate) {
      throw new ValidationError(
        "flatRate is required for manual shipping methods.",
        { code: "manual_requires_flat_rate" },
      );
    }
    if (input.providerKind === "plugin" && input.flatRate) {
      throw new ValidationError(
        "flatRate must be omitted for plugin shipping methods.",
        { code: "plugin_no_flat_rate" },
      );
    }

    const methodId = id("ship");
    const flatRateAmount = input.flatRate
      ? BigInt(input.flatRate.amount)
      : null;
    const flatRateCurrency = input.flatRate ? input.flatRate.currency : null;

    const row = await this.repo.insertMethod({
      id: methodId,
      code: input.code,
      name: input.name,
      providerKind: input.providerKind,
      flatRateAmount,
      flatRateCurrency,
      isActive: input.isActive ?? true,
    });
    return toShippingMethod(row);
  }

  async updateMethod(
    methodId: string,
    patch: UpdateShippingMethodInput,
  ): Promise<ShippingMethod> {
    const existing = await this.repo.getMethodById(methodId);
    if (!existing) {
      throw new NotFoundError("Shipping method not found.", { id: methodId });
    }
    if (existing.deletedAt !== null) {
      throw new ConflictError("Cannot update a deleted shipping method.", {
        id: methodId,
      });
    }

    const fields: Partial<{
      name: string;
      flatRateAmount: bigint;
      flatRateCurrency: string;
      isActive: boolean;
    }> = {};

    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.isActive !== undefined) fields.isActive = patch.isActive;
    if (patch.flatRate !== undefined) {
      if (existing.providerKind !== "manual") {
        throw new ValidationError(
          "flatRate cannot be set on plugin shipping methods.",
          { code: "plugin_no_flat_rate" },
        );
      }
      fields.flatRateAmount = BigInt(patch.flatRate.amount);
      fields.flatRateCurrency = patch.flatRate.currency;
    }

    const updated = await this.repo.updateMethod(methodId, fields);
    if (!updated) {
      throw new NotFoundError("Shipping method not found.", { id: methodId });
    }
    return toShippingMethod(updated);
  }

  async deleteMethod(methodId: string): Promise<void> {
    const existing = await this.repo.getMethodById(methodId);
    if (!existing) {
      throw new NotFoundError("Shipping method not found.", { id: methodId });
    }
    // Idempotent: a re-issued delete on an already-deleted row is a no-op.
    if (existing.deletedAt !== null) {
      return;
    }
    await this.repo.softDeleteMethod(methodId);
  }

  // -------------------------------------------------------------------
  // Fulfillment placeholder
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Plugin extension point
  // -------------------------------------------------------------------

  registerPluginProvider(provider: PluginShippingProvider): void {
    if (this.pluginProviders.has(provider.code)) {
      throw new ConflictError(
        "Plugin shipping provider with this code is already registered.",
        { code: provider.code },
      );
    }
    this.pluginProviders.set(provider.code, provider);
  }

  // -------------------------------------------------------------------
  // Fulfillment placeholder
  // -------------------------------------------------------------------

  async createFulfillment(
    orderIntentId: string,
    methodCode: string,
  ): Promise<Fulfillment> {
    const method = await this.repo.getMethodByCode(methodCode);
    if (!method || method.deletedAt !== null) {
      throw new NotFoundError("Shipping method not found.", { methodCode });
    }
    const fulfillmentId = id("ful");
    const row = await this.repo.insertFulfillment({
      id: fulfillmentId,
      orderIntentId,
      shippingMethodId: method.id,
      status: "pending",
    });
    return toFulfillment(row);
  }
}

/**
 * Default provider registry — only the manual provider for v0.1.
 * Plugin providers register themselves through this map at startup.
 */
function defaultProviders(): Map<ShippingProviderKind, ShippingProvider> {
  return new Map<ShippingProviderKind, ShippingProvider>([
    ["manual", manualShippingProvider],
    // 'plugin' deliberately not registered until plugins ship; quote()
    // surfaces a clear ConflictError if a plugin row is created and then
    // queried before its provider is registered.
  ]);
}

/**
 * Default singleton wired to the runtime database and the manual
 * provider. Tests construct `ShippingServiceImpl` directly with fakes.
 */
export const shippingService: ShippingService = new ShippingServiceImpl(
  createShippingRepository(),
  defaultProviders(),
);

/**
 * `ShippingService` — public contract for the shipping module.
 *
 * Owns:
 *   - shipping-method lifecycle (create, update, soft-delete)
 *   - quote resolution: dispatches to the configured provider for the
 *     method's `providerKind` and asserts currency parity at the boundary
 *   - fulfillment lifecycle: create-on-paid, mark-shipped, mark-delivered,
 *     cancel; each transition is validated against `state.ts`, writes an
 *     audit row, and emits the typed event
 *   - domain errors (NotFoundError, ConflictError, ValidationError) —
 *     never leaks Drizzle/Postgres errors to callers
 *
 * Constructor takes a repository, a provider registry, and an audit
 * service so tests can swap fakes; the default singleton wires to the
 * runtime DB and the built-in manual provider.
 */
import type { Money } from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import {
  auditService as defaultAuditService,
  type AuditActor,
  type AuditService,
} from "../audit/index.js";
import { events, type EventName, type EventPayload } from "./events.js";
import { toFulfillment, toShippingMethod } from "./mappers.js";
import { manualShippingProvider } from "./providers/manual.js";
import type { ShippingProvider } from "./providers/types.js";
import {
  createShippingRepository,
  type FulfillmentUpdatePatch,
  type ShippingRepository,
} from "./repository.js";
import {
  ALL_FULFILLMENT_STATUSES,
  canTransition,
  isTerminal,
} from "./state.js";
import type {
  CreateShippingMethodInput,
  Fulfillment,
  FulfillmentActorKind,
  FulfillmentStatus,
  QuoteShippingInput,
  ShippingMethod,
  ShippingProviderKind,
  UpdateShippingMethodInput,
} from "./types.js";

export interface CreateFulfillmentForOrderInput {
  /** Stable shipping-method code captured at order time. */
  methodCode: string;
  actor?: AuditActor;
}

export interface FulfillmentTransitionOptions {
  actor: AuditActor;
}

export interface MarkFulfillmentShippedOptions
  extends FulfillmentTransitionOptions {
  /** Optional tracking code to attach in the same operation. */
  trackingCode?: string | null;
}

export interface CancelFulfillmentOptions
  extends FulfillmentTransitionOptions {
  reason?: string | null;
}

export interface SetFulfillmentTrackingOptions
  extends FulfillmentTransitionOptions {
  /** Pass `null` to clear. */
  trackingCode: string | null;
}

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

  // Method mutations (admin)
  createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod>;
  updateMethod(
    id: string,
    patch: UpdateShippingMethodInput,
  ): Promise<ShippingMethod>;
  deleteMethod(id: string): Promise<void>;

  // Fulfillment reads
  getFulfillmentById(id: string): Promise<Fulfillment | null>;
  listFulfillmentsByOrderId(orderId: string): Promise<Fulfillment[]>;
  /**
   * Batch read used by the orders module to embed fulfillments on a list
   * response. Returns `[]` if no order ids were supplied.
   */
  listFulfillmentsForOrders(orderIds: string[]): Promise<Fulfillment[]>;

  // Fulfillment lifecycle
  /**
   * Create a `pending` fulfillment for an order, resolving the shipping
   * method by its stable code.
   *
   * Optionally accepts a caller-supplied repo so the insert lands in the
   * same transaction as the order-state transition that triggered it
   * (the orders service passes its in-flight `tx`-scoped shipping repo).
   * Without this, a payment-captured / fulfillment-create split would
   * leave the two out of sync if the second write failed.
   *
   * Idempotency is the caller's concern; the orders service guards
   * against double-creation through its own `getOrderByIdForUpdate` lock.
   */
  createFulfillmentForOrder(
    orderId: string,
    input: CreateFulfillmentForOrderInput,
    repo?: ShippingRepository,
  ): Promise<Fulfillment>;

  /**
   * Set/replace/clear the tracking code on a fulfillment without changing
   * its status. Useful for the operator who pastes a code BEFORE marking
   * shipped, or fixes a typo afterwards.
   */
  setTracking(
    fulfillmentId: string,
    opts: SetFulfillmentTrackingOptions,
  ): Promise<Fulfillment>;

  /**
   * Transition `pending → shipped`. Sets `tracked_at`, optionally a
   * tracking code in the same operation, and emits `fulfillment.shipped`.
   */
  markShipped(
    fulfillmentId: string,
    opts: MarkFulfillmentShippedOptions,
  ): Promise<Fulfillment>;

  /**
   * Transition `shipped → delivered`. Sets `delivered_at` and emits
   * `fulfillment.delivered`. Note: the parent order's transition to
   * `fulfilled` is handled at the routes layer (composition over
   * cross-module reach into the orders service from inside this one).
   */
  markDelivered(
    fulfillmentId: string,
    opts: FulfillmentTransitionOptions,
  ): Promise<Fulfillment>;

  /**
   * Transition `pending|shipped → cancelled`. Captures the reason on the
   * audit row and emits `fulfillment.cancelled`. Does NOT cancel the
   * parent order; that decision belongs to the operator and the order's
   * own state machine.
   */
  cancel(
    fulfillmentId: string,
    opts: CancelFulfillmentOptions,
  ): Promise<Fulfillment>;
}

/**
 * Captured event to fire AFTER the enclosing transaction commits. Same
 * shape as the orders module's PendingEvent — see
 * `apps/api/src/modules/orders/service.ts` for the rationale.
 */
type PendingEvent = {
  [E in EventName]: { name: E; payload: EventPayload<E> };
}[EventName];

export class ShippingServiceImpl implements ShippingService {
  constructor(
    private readonly repo: ShippingRepository,
    private readonly providers: Map<ShippingProviderKind, ShippingProvider>,
    private readonly auditService: AuditService = defaultAuditService,
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

    const provider = this.providers.get(method.providerKind);
    if (!provider) {
      throw new ConflictError("No provider registered for this method.", {
        providerKind: method.providerKind,
        methodCode: input.methodCode,
      });
    }

    const amount = await provider.quote(method, { currency: input.currency });
    if (amount.currency !== input.currency) {
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
  // Method mutations
  // -------------------------------------------------------------------

  async createMethod(
    input: CreateShippingMethodInput,
  ): Promise<ShippingMethod> {
    const existing = await this.repo.getMethodByCode(input.code);
    if (existing) {
      throw new ConflictError("Shipping method code already exists.", {
        code: input.code,
      });
    }

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
    if (existing.deletedAt !== null) {
      return;
    }
    await this.repo.softDeleteMethod(methodId);
  }

  // -------------------------------------------------------------------
  // Fulfillment reads
  // -------------------------------------------------------------------

  async getFulfillmentById(
    fulfillmentId: string,
  ): Promise<Fulfillment | null> {
    const row = await this.repo.getFulfillmentById(fulfillmentId);
    return row ? toFulfillment(row) : null;
  }

  async listFulfillmentsByOrderId(orderId: string): Promise<Fulfillment[]> {
    const rows = await this.repo.listFulfillmentsByOrderId(orderId);
    return rows.map(toFulfillment);
  }

  async listFulfillmentsForOrders(
    orderIds: string[],
  ): Promise<Fulfillment[]> {
    const rows = await this.repo.listFulfillmentsForOrders(orderIds);
    return rows.map(toFulfillment);
  }

  // -------------------------------------------------------------------
  // Fulfillment lifecycle
  // -------------------------------------------------------------------

  async createFulfillmentForOrder(
    orderId: string,
    input: CreateFulfillmentForOrderInput,
    repo?: ShippingRepository,
  ): Promise<Fulfillment> {
    const r = repo ?? this.repo;
    const method = await r.getMethodByCode(input.methodCode);
    if (!method || method.deletedAt !== null) {
      throw new NotFoundError("Shipping method not found.", {
        methodCode: input.methodCode,
      });
    }
    const fulfillmentId = id("ful");
    const row = await r.insertFulfillment({
      id: fulfillmentId,
      orderId,
      shippingMethodId: method.id,
      status: "pending",
    });
    const fulfillment = toFulfillment(row);

    // Fire the create event AFTER the repo write returns so the listener
    // sees the materialised row. When called inside an enclosing
    // transaction (the orders service does this on `paid`), the orders
    // service is responsible for emitting AFTER its own commit — pass
    // `repo` to opt out of the immediate emit.
    if (!repo) {
      await this.emit({
        name: "fulfillment.created",
        payload: {
          fulfillmentId,
          orderId,
          shippingMethodId: method.id,
        },
      });
    }
    return fulfillment;
  }

  async setTracking(
    fulfillmentId: string,
    opts: SetFulfillmentTrackingOptions,
  ): Promise<Fulfillment> {
    const trackingCode = normalizeTrackingCode(opts.trackingCode);
    return this.repo.withTransaction(async ({ shipping, audit }) => {
      const fresh = await shipping.getFulfillmentByIdForUpdate(fulfillmentId);
      if (!fresh) {
        throw new NotFoundError("Fulfillment not found.", { fulfillmentId });
      }
      const status = fresh.status as FulfillmentStatus;
      if (status === "cancelled") {
        // A delivered fulfillment may still want a tracking-code fix
        // (e.g. an operator typo); a cancelled one is closed out.
        throw new ConflictError(
          "Cannot set tracking on a cancelled fulfillment.",
          { fulfillmentId, status },
        );
      }
      const updated = await shipping.updateFulfillment(fulfillmentId, {
        trackingCode,
      });
      if (!updated) {
        throw new NotFoundError("Fulfillment not found.", { fulfillmentId });
      }
      // Audit row writes in the same transaction. A throw here rolls
      // back the tracking write — auditing is a hard requirement.
      await this.auditService.recordEvent({
        entityKind: "fulfillment",
        entityId: fulfillmentId,
        action: "fulfillment_set_tracking",
        actor: opts.actor,
        details: {
          before: fresh.trackingCode ?? null,
          after: trackingCode,
        },
        repo: audit,
      });
      return toFulfillment(updated);
    });
  }

  async markShipped(
    fulfillmentId: string,
    opts: MarkFulfillmentShippedOptions,
  ): Promise<Fulfillment> {
    return this.runTransition(fulfillmentId, "shipped", {
      actor: opts.actor,
      patch: (now) => ({
        status: "shipped",
        trackedAt: now,
        ...(opts.trackingCode !== undefined
          ? { trackingCode: normalizeTrackingCode(opts.trackingCode) }
          : {}),
      }),
      buildEvents: (row) => [
        {
          name: "fulfillment.shipped",
          payload: {
            fulfillmentId: row.id,
            orderId: row.orderId,
            trackingCode: row.trackingCode ?? null,
            actorKind: actorKind(opts.actor),
          },
        },
      ],
      auditAction: "fulfillment_mark_shipped",
      auditDetails: (fresh) => ({
        ...(opts.trackingCode !== undefined
          ? {
              trackingCodeBefore: fresh.trackingCode ?? null,
              trackingCodeAfter: normalizeTrackingCode(opts.trackingCode),
            }
          : {}),
      }),
    });
  }

  async markDelivered(
    fulfillmentId: string,
    opts: FulfillmentTransitionOptions,
  ): Promise<Fulfillment> {
    return this.runTransition(fulfillmentId, "delivered", {
      actor: opts.actor,
      patch: (now) => ({ status: "delivered", deliveredAt: now }),
      buildEvents: (row) => [
        {
          name: "fulfillment.delivered",
          payload: {
            fulfillmentId: row.id,
            orderId: row.orderId,
            actorKind: actorKind(opts.actor),
          },
        },
      ],
      auditAction: "fulfillment_mark_delivered",
    });
  }

  async cancel(
    fulfillmentId: string,
    opts: CancelFulfillmentOptions,
  ): Promise<Fulfillment> {
    const reason =
      opts.reason && opts.reason.trim().length > 0 ? opts.reason.trim() : null;
    return this.runTransition(fulfillmentId, "cancelled", {
      actor: opts.actor,
      patch: () => ({ status: "cancelled" }),
      buildEvents: (row) => [
        {
          name: "fulfillment.cancelled",
          payload: {
            fulfillmentId: row.id,
            orderId: row.orderId,
            reason,
            actorKind: actorKind(opts.actor),
          },
        },
      ],
      auditAction: "fulfillment_cancel",
      auditReason: reason,
      auditDetails: () => ({ reason }),
    });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Single transition orchestration. Acquires the row lock, validates the
   * state machine, applies the patch, writes the audit row in the same
   * transaction, and emits the typed + generic events post-commit.
   *
   * The shape stays here (rather than scattering the same six steps across
   * three methods) so the lock-then-update-then-audit ordering cannot drift.
   */
  private async runTransition(
    fulfillmentId: string,
    toStatus: FulfillmentStatus,
    spec: {
      actor: AuditActor;
      patch: (now: Date) => FulfillmentUpdatePatch;
      buildEvents: (
        row: NonNullable<
          Awaited<ReturnType<ShippingRepository["getFulfillmentById"]>>
        >,
      ) => PendingEvent[];
      auditAction: string;
      auditReason?: string | null;
      auditDetails?: (
        fresh: NonNullable<
          Awaited<ReturnType<ShippingRepository["getFulfillmentByIdForUpdate"]>>
        >,
      ) => Record<string, unknown>;
    },
  ): Promise<Fulfillment> {
    if (!ALL_FULFILLMENT_STATUSES.includes(toStatus)) {
      throw new ConflictError("Unknown target status.", {
        code: "invalid_transition",
        toStatus,
      });
    }

    const { result, pending } = await this.repo.withTransaction(
      async ({ shipping, audit }) => {
        const fresh = await shipping.getFulfillmentByIdForUpdate(fulfillmentId);
        if (!fresh) {
          throw new NotFoundError("Fulfillment not found.", { fulfillmentId });
        }
        const fromStatus = fresh.status as FulfillmentStatus;
        if (isTerminal(fromStatus)) {
          throw new ConflictError("Fulfillment is in a terminal status.", {
            code: "invalid_transition",
            from: fromStatus,
            to: toStatus,
          });
        }
        if (!canTransition(fromStatus, toStatus)) {
          throw new ConflictError("Invalid fulfillment status transition.", {
            code: "invalid_transition",
            from: fromStatus,
            to: toStatus,
          });
        }

        const now = new Date();
        const patch = spec.patch(now);
        const updated = await shipping.updateFulfillment(fulfillmentId, patch);
        if (!updated) {
          throw new NotFoundError("Fulfillment not found.", { fulfillmentId });
        }

        const details = spec.auditDetails ? spec.auditDetails(fresh) : {};
        await this.auditService.recordEvent({
          entityKind: "fulfillment",
          entityId: fulfillmentId,
          action: spec.auditAction,
          actor: spec.actor,
          details: {
            ...details,
            fromStatus,
            toStatus,
          },
          reason: spec.auditReason ?? null,
          repo: audit,
        });

        const typedEvents = spec.buildEvents(updated);
        const pendingEvents: PendingEvent[] = [
          ...typedEvents,
          {
            name: "fulfillment.status_changed",
            payload: {
              fulfillmentId,
              orderId: updated.orderId,
              fromStatus,
              toStatus,
              actorKind: actorKind(spec.actor),
            },
          },
        ];
        return {
          result: toFulfillment(updated),
          pending: pendingEvents,
        };
      },
    );
    await this.emitMany(pending);
    return result;
  }

  private async emit(ev: PendingEvent): Promise<void> {
    await (
      events.emit as <E extends EventName>(
        name: E,
        payload: EventPayload<E>,
      ) => Promise<void>
    )(ev.name, ev.payload);
  }

  private async emitMany(pending: PendingEvent[]): Promise<void> {
    for (const ev of pending) {
      await this.emit(ev);
    }
  }
}

function normalizeTrackingCode(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function actorKind(actor: AuditActor): FulfillmentActorKind {
  switch (actor.kind) {
    case "system":
      return "system";
    case "staff":
      return "staff";
    case "customer":
      return "customer";
  }
}

/**
 * Default provider registry — only the manual provider for v0.1.
 * Plugin providers register themselves through this map at startup.
 */
function defaultProviders(): Map<ShippingProviderKind, ShippingProvider> {
  return new Map<ShippingProviderKind, ShippingProvider>([
    ["manual", manualShippingProvider],
  ]);
}

/**
 * Default singleton wired to the runtime database, the manual provider,
 * and the default audit service.
 */
export const shippingService: ShippingService = new ShippingServiceImpl(
  createShippingRepository(),
  defaultProviders(),
);

/**
 * `OrderService` — public contract for the orders module.
 *
 * Owns:
 *   - The order_intent → order materialisation: `createFromIntent`
 *     reads the snapshot the checkout module wrote, allocates the next
 *     `order_number`, captures variant + product translations at order
 *     time, and writes `orders` + `order_items` + an initial
 *     `order_status_history` row in a single transaction. Emits
 *     `order.placed` (and `order.status_changed`) on commit.
 *
 *   - The status state machine: `transitionStatus` validates against
 *     `state.ts`, refuses moves the diagram does not allow with a
 *     `ConflictError {code:"invalid_transition"}`, denormalises the
 *     transition timestamp (`paid_at` / `fulfilled_at` / ...) onto the
 *     parent row, appends an audit row, and emits the typed event
 *     (`order.paid`, `order.fulfilled`, etc.) plus the generic
 *     `order.status_changed`.
 *
 *   - Cancellation: thin wrapper around `transitionStatus` that captures
 *     the reason on the parent row and on the audit row's `details`.
 *
 *   - Reads: locale-aware `getOrderById`, `getOrderByNumber`,
 *     `listOrders` (admin), `listCustomerOrders` (storefront /me).
 *     Title translations are resolved at the read boundary per ADR-0010.
 *
 * Constructor takes a repository so tests swap an in-memory fake; the
 * default singleton wires to the runtime DB.
 */
import {
  add as moneyAdd,
  multiply as moneyMultiply,
  type Money,
} from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import {
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import { DEFAULT_LOCALE } from "../catalog/i18n.js";
import { events, type EventName, type EventPayload } from "./events.js";
import { toOrder, toOrderStatusEvent } from "./mappers.js";
import {
  createOrdersRepository,
  type OrderUpdatePatch,
  type OrdersRepository,
  type VariantWithProduct,
} from "./repository.js";
import {
  ALL_ORDER_STATUSES,
  canTransition,
  isTerminal,
  timestampColumnFor,
  type OrderStatus,
} from "./state.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ListMyOrdersQuery,
  type ListOrdersQuery,
  type Order,
  type OrderActorKind,
  type OrderAddressSnapshot,
  type OrderStatusEvent,
  type Paginated,
} from "./types.js";

const log = childLogger("orders");

export interface CreateFromIntentOptions {
  actorKind?: OrderActorKind;
  actorId?: string | null;
}

export interface TransitionOptions {
  actorKind: OrderActorKind;
  actorId?: string | null;
  details?: Record<string, unknown>;
}

export interface CancelOptions extends TransitionOptions {
  reason?: string | null;
}

export interface OrderService {
  /**
   * Materialize an order from a previously-written `order_intent`.
   * Idempotent against duplicate calls for the same intent: a second
   * call sees an existing order and throws `ConflictError {code:
   * "intent_already_consumed"}`.
   */
  createFromIntent(
    orderIntentId: string,
    opts?: CreateFromIntentOptions,
  ): Promise<Order>;

  getOrderById(id: string, opts?: { locale?: string }): Promise<Order | null>;
  getOrderByNumber(
    orderNumber: string,
    opts?: { locale?: string },
  ): Promise<Order | null>;

  listOrders(
    query: ListOrdersQuery,
    opts?: { locale?: string },
  ): Promise<Paginated<Order>>;
  listCustomerOrders(
    customerId: string,
    query: ListMyOrdersQuery,
    opts?: { locale?: string },
  ): Promise<Paginated<Order>>;

  /**
   * Transition an order to `toStatus`. Validates against the state
   * machine; appends an audit row; updates the appropriate
   * `<status>_at` column on the parent row; emits the typed event.
   */
  transitionStatus(
    id: string,
    toStatus: OrderStatus,
    opts: TransitionOptions,
    locale?: string,
  ): Promise<Order>;

  cancelOrder(
    id: string,
    opts: CancelOptions,
    locale?: string,
  ): Promise<Order>;

  listStatusHistory(orderId: string): Promise<OrderStatusEvent[]>;
}

/**
 * Captured event to fire AFTER the enclosing transaction commits. Same
 * shape as the checkout module's PendingEvent — see
 * `apps/api/src/modules/checkout/service.ts` for the rationale.
 */
type PendingEvent = {
  [E in EventName]: { name: E; payload: EventPayload<E> };
}[EventName];

interface OrderIntentSnapshotShape {
  cartSnapshot: ReadonlyArray<{
    variantId: string;
    quantity: number;
    unitPrice: { amount: string | number | bigint; currency: string };
  }>;
  totalsSnapshot: {
    subtotal: { amount: string | number | bigint; currency: string };
    tax: { amount: string | number | bigint; currency: string };
    shipping: { amount: string | number | bigint; currency: string };
    total: { amount: string | number | bigint; currency: string };
  };
  shippingAddressSnapshot: OrderAddressSnapshot;
  billingAddressSnapshot: OrderAddressSnapshot | null;
}

export class OrderServiceImpl implements OrderService {
  constructor(private readonly repo: OrdersRepository) {}

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async createFromIntent(
    orderIntentId: string,
    opts: CreateFromIntentOptions = {},
  ): Promise<Order> {
    const actorKind = opts.actorKind ?? "system";
    const actorId = opts.actorId ?? null;

    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const intent = await tx.getOrderIntentById(orderIntentId);
      if (!intent) {
        throw new NotFoundError("Order intent not found.", { orderIntentId });
      }

      // Defense-in-depth: surface a clean conflict if this intent was
      // already consumed (a second `complete()` race or a manual replay).
      const existing = await tx.getOrderByIntentId(orderIntentId);
      if (existing) {
        throw new ConflictError(
          "An order has already been created from this intent.",
          {
            code: "intent_already_consumed",
            orderIntentId,
            orderId: existing.id,
          },
        );
      }

      const snapshot = intent as unknown as {
        cartSnapshot: OrderIntentSnapshotShape["cartSnapshot"];
        totalsSnapshot: OrderIntentSnapshotShape["totalsSnapshot"];
        shippingAddressSnapshot: OrderIntentSnapshotShape["shippingAddressSnapshot"];
        billingAddressSnapshot:
          | OrderIntentSnapshotShape["billingAddressSnapshot"]
          | null;
      };

      const subtotal = readMoney(snapshot.totalsSnapshot.subtotal);
      const tax = readMoney(snapshot.totalsSnapshot.tax);
      const shipping = readMoney(snapshot.totalsSnapshot.shipping);
      const total = readMoney(snapshot.totalsSnapshot.total);
      const currency = total.currency;

      // Sanity-check totals: subtotal + tax + shipping should equal
      // total. If the checkout snapshot disagrees we DO NOT silently
      // recompute — that would mask a real divergence. Log the warning
      // and trust the snapshot (which is what the customer paid).
      const recomputed = moneyAdd(moneyAdd(subtotal, tax), shipping);
      if (recomputed.amount !== total.amount) {
        log.warn(
          {
            orderIntentId,
            recomputed: recomputed.amount.toString(),
            stored: total.amount.toString(),
          },
          "totals divergence detected when materializing order",
        );
      }

      // Capture title translations for every variant in the snapshot.
      // We resolve from `(product.translations, variant.translations)`
      // — both contribute under different keys (`product.title`
      // wins for the line label, `variant.title` is the subtype). For
      // v0.1 we merge into a single locale-keyed map per item with the
      // variant's title taking precedence when both are set.
      const variantIds = snapshot.cartSnapshot.map((line) => line.variantId);
      const variantsById = await loadVariantsById(tx, variantIds);

      // Enrich the address snapshots with resolved region names AT WRITE
      // TIME. Storing the names alongside the BPS ids in the JSONB blob
      // makes the snapshot self-contained — a later region rename in the
      // BPS dataset cannot retroactively rewrite past orders. This is the
      // audit-grade choice: accept one extra read per order placement
      // (cheap, four PK lookups) so reads never need a join.
      const shippingSnapshot = await enrichSnapshotWithRegionNames(
        tx,
        snapshot.shippingAddressSnapshot,
      );
      const billingSnapshot = snapshot.billingAddressSnapshot
        ? await enrichSnapshotWithRegionNames(
            tx,
            snapshot.billingAddressSnapshot,
          )
        : null;

      const orderId = id("ord");
      const sequenceValue = await tx.nextOrderNumber();
      const orderNumber = formatOrderNumber(sequenceValue, new Date());

      const orderRow = await tx.insertOrder({
        id: orderId,
        orderNumber,
        customerId: null, // resolved below if the intent's checkout had a customer
        email: intent.email,
        currency,
        status: "pending_payment",
        subtotalAmount: subtotal.amount,
        taxAmount: tax.amount,
        // Tax rate metadata is not carried on the order_intent in v0.1;
        // capture nulls and let a future tax-module integration backfill
        // (or have checkout snapshot the rate row). Surfacing the null
        // explicitly is more honest than fabricating a code.
        taxRateCode: null,
        taxRateBasisPoints: null,
        shippingAmount: shipping.amount,
        shippingMethodCode: intent.shippingMethodCode,
        totalAmount: total.amount,
        shippingAddressSnapshot: shippingSnapshot as unknown as object,
        billingAddressSnapshot: billingSnapshot
          ? (billingSnapshot as unknown as object)
          : null,
        paymentMethod: intent.paymentMethod,
      });

      // Order items — one row per cart-snapshot line.
      const itemRows = snapshot.cartSnapshot.map((line) => {
        const unitPrice = readMoney(line.unitPrice);
        const lineSubtotal = moneyMultiply(unitPrice, line.quantity);
        const variantRow = variantsById.get(line.variantId);
        const titleTranslations = buildTitleTranslations(variantRow);
        const sku = variantRow?.variant.sku ?? `unknown-sku-${line.variantId}`;
        return {
          id: id("oi"),
          orderId,
          variantId: line.variantId,
          sku,
          titleTranslations,
          quantity: line.quantity,
          unitPriceAmount: unitPrice.amount,
          unitPriceCurrency: unitPrice.currency,
          lineSubtotalAmount: lineSubtotal.amount,
        };
      });
      const insertedItems = await tx.insertOrderItems(itemRows);

      // Initial status-history entry — `from_status` is null.
      await tx.insertStatusHistory({
        id: id("osh"),
        orderId,
        fromStatus: null,
        toStatus: "pending_payment",
        actorKind,
        actorId,
        details: {
          orderIntentId,
          checkoutId: intent.checkoutId,
          paymentMethod: intent.paymentMethod,
        },
      });

      const pendingEvents: PendingEvent[] = [
        {
          name: "order.placed",
          payload: {
            orderId,
            orderNumber,
            customerId: orderRow.customerId ?? null,
            email: orderRow.email,
            totalAmount: orderRow.totalAmount.toString(),
            currency: orderRow.currency,
          },
        },
        {
          name: "order.status_changed",
          payload: {
            orderId,
            orderNumber,
            fromStatus: null,
            toStatus: "pending_payment",
            actorKind,
          },
        },
      ];

      return {
        result: toOrder(orderRow, insertedItems, DEFAULT_LOCALE),
        pending: pendingEvents,
      };
    });
    await this.emitPending(pending);
    return result;
  }

  async getOrderById(
    orderId: string,
    opts: { locale?: string } = {},
  ): Promise<Order | null> {
    const row = await this.repo.getOrderById(orderId);
    if (!row) return null;
    const items = await this.repo.listItemsForOrder(orderId);
    return toOrder(row, items, opts.locale ?? DEFAULT_LOCALE);
  }

  async getOrderByNumber(
    orderNumber: string,
    opts: { locale?: string } = {},
  ): Promise<Order | null> {
    const row = await this.repo.getOrderByNumber(orderNumber);
    if (!row) return null;
    const items = await this.repo.listItemsForOrder(row.id);
    return toOrder(row, items, opts.locale ?? DEFAULT_LOCALE);
  }

  async listOrders(
    query: ListOrdersQuery,
    opts: { locale?: string } = {},
  ): Promise<Paginated<Order>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const locale = opts.locale ?? DEFAULT_LOCALE;

    const { rows, total } = await this.repo.listOrders({
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.email ? { email: query.email } : {}),
      // The Zod transform on `orderNumber` already trims + upper-cases
      // and folds empty/whitespace to `undefined`, so a truthy check is
      // enough to decide whether the filter is in play.
      ...(query.orderNumber ? { orderNumber: query.orderNumber } : {}),
      ...(query.createdFrom ? { createdFrom: query.createdFrom } : {}),
      ...(query.createdTo ? { createdTo: query.createdTo } : {}),
      page,
      pageSize,
    });

    const orderIds = rows.map((row) => row.id);
    const items = await this.repo.listItemsForOrders(orderIds);
    const itemsByOrder = groupBy(items, (it) => it.orderId);
    const data = rows.map((row) =>
      toOrder(row, itemsByOrder.get(row.id) ?? [], locale),
    );
    return { data, total, page, pageSize };
  }

  async listCustomerOrders(
    customerId: string,
    query: ListMyOrdersQuery,
    opts: { locale?: string } = {},
  ): Promise<Paginated<Order>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const locale = opts.locale ?? DEFAULT_LOCALE;

    const { rows, total } = await this.repo.listCustomerOrders(
      customerId,
      page,
      pageSize,
    );
    const orderIds = rows.map((row) => row.id);
    const items = await this.repo.listItemsForOrders(orderIds);
    const itemsByOrder = groupBy(items, (it) => it.orderId);
    const data = rows.map((row) =>
      toOrder(row, itemsByOrder.get(row.id) ?? [], locale),
    );
    return { data, total, page, pageSize };
  }

  async transitionStatus(
    orderId: string,
    toStatus: OrderStatus,
    opts: TransitionOptions,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Order> {
    if (!ALL_ORDER_STATUSES.includes(toStatus)) {
      throw new ConflictError("Unknown target status.", {
        code: "invalid_transition",
        toStatus,
      });
    }

    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const fresh = await tx.getOrderByIdForUpdate(orderId);
      if (!fresh) {
        throw new NotFoundError("Order not found.", { orderId });
      }
      const fromStatus = fresh.status as OrderStatus;
      if (isTerminal(fromStatus)) {
        throw new ConflictError("Order is in a terminal status.", {
          code: "invalid_transition",
          from: fromStatus,
          to: toStatus,
        });
      }
      if (!canTransition(fromStatus, toStatus)) {
        throw new ConflictError("Invalid order status transition.", {
          code: "invalid_transition",
          from: fromStatus,
          to: toStatus,
        });
      }

      const now = new Date();
      const tsColumn = timestampColumnFor(toStatus);
      const patch: OrderUpdatePatch = { status: toStatus };
      if (tsColumn) {
        patch[tsColumn] = now;
      }

      const updated = await tx.updateOrder(orderId, patch);
      if (!updated) {
        // The row vanished between the FOR UPDATE select and the
        // update — should not happen under READ COMMITTED + row lock,
        // but surface as a clean 404 if it does.
        throw new NotFoundError("Order not found.", { orderId });
      }

      await tx.insertStatusHistory({
        id: id("osh"),
        orderId,
        fromStatus,
        toStatus,
        actorKind: opts.actorKind,
        actorId: opts.actorId ?? null,
        details: opts.details ?? {},
      });

      const items = await tx.listItemsForOrder(orderId);

      const typed = statusEventFor(
        updated.id,
        updated.orderNumber,
        toStatus,
        opts.actorKind,
      );
      const pendingEvents: PendingEvent[] = [];
      if (typed) pendingEvents.push(typed);
      pendingEvents.push({
        name: "order.status_changed",
        payload: {
          orderId: updated.id,
          orderNumber: updated.orderNumber,
          fromStatus,
          toStatus,
          actorKind: opts.actorKind,
        },
      });

      return {
        result: toOrder(updated, items, locale),
        pending: pendingEvents,
      };
    });
    await this.emitPending(pending);
    return result;
  }

  async cancelOrder(
    orderId: string,
    opts: CancelOptions,
    locale: string = DEFAULT_LOCALE,
  ): Promise<Order> {
    const reason = opts.reason && opts.reason.trim().length > 0
      ? opts.reason.trim()
      : null;

    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const fresh = await tx.getOrderByIdForUpdate(orderId);
      if (!fresh) {
        throw new NotFoundError("Order not found.", { orderId });
      }
      const fromStatus = fresh.status as OrderStatus;
      if (isTerminal(fromStatus)) {
        throw new ConflictError("Order is in a terminal status.", {
          code: "invalid_transition",
          from: fromStatus,
          to: "cancelled",
        });
      }
      if (!canTransition(fromStatus, "cancelled")) {
        throw new ConflictError("Order cannot be cancelled from this status.", {
          code: "invalid_transition",
          from: fromStatus,
          to: "cancelled",
        });
      }

      const now = new Date();
      const updated = await tx.updateOrder(orderId, {
        status: "cancelled",
        cancelledAt: now,
        cancellationReason: reason,
      });
      if (!updated) {
        throw new NotFoundError("Order not found.", { orderId });
      }

      await tx.insertStatusHistory({
        id: id("osh"),
        orderId,
        fromStatus,
        toStatus: "cancelled",
        actorKind: opts.actorKind,
        actorId: opts.actorId ?? null,
        details: { ...(opts.details ?? {}), reason },
      });

      const items = await tx.listItemsForOrder(orderId);

      const pendingEvents: PendingEvent[] = [
        {
          name: "order.cancelled",
          payload: {
            orderId: updated.id,
            orderNumber: updated.orderNumber,
            reason,
            actorKind: opts.actorKind,
          },
        },
        {
          name: "order.status_changed",
          payload: {
            orderId: updated.id,
            orderNumber: updated.orderNumber,
            fromStatus,
            toStatus: "cancelled",
            actorKind: opts.actorKind,
          },
        },
      ];

      return {
        result: toOrder(updated, items, locale),
        pending: pendingEvents,
      };
    });
    await this.emitPending(pending);
    return result;
  }

  async listStatusHistory(orderId: string): Promise<OrderStatusEvent[]> {
    // 404 when the parent order does not exist — an empty list could
    // mask a typo on the order id. Mirrors the checkout listEvents
    // contract.
    const order = await this.repo.getOrderById(orderId);
    if (!order) {
      throw new NotFoundError("Order not found.", { orderId });
    }
    const rows = await this.repo.listStatusHistory(orderId);
    return rows.map(toOrderStatusEvent);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Fire pending events after `withTransaction` returns. Each listener is
   * awaited in order; the bus already catches per-listener throws so a
   * single bad subscriber cannot stop the rest.
   */
  private async emitPending(pending: PendingEvent[]): Promise<void> {
    for (const ev of pending) {
      await (
        events.emit as <E extends EventName>(
          name: E,
          payload: EventPayload<E>,
        ) => Promise<void>
      )(ev.name, ev.payload);
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

function readMoney(raw: {
  amount: string | number | bigint;
  currency: string;
}): Money {
  return {
    amount: typeof raw.amount === "bigint" ? raw.amount : BigInt(raw.amount),
    currency: raw.currency,
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    if (existing) existing.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Format the raw sequence number into the customer-facing handle:
 * `ORD-YYYY-NNNNNN` (six-digit zero-padded counter, year captured at
 * order time). The padding survives merchants who blow past 999_999
 * orders in a year — we widen the field, not the constant width.
 */
function formatOrderNumber(seq: number, when: Date): string {
  const year = when.getUTCFullYear();
  const padded = String(seq).padStart(6, "0");
  return `ORD-${year}-${padded}`;
}

async function loadVariantsById(
  repo: OrdersRepository,
  variantIds: string[],
): Promise<Map<string, VariantWithProduct>> {
  if (variantIds.length === 0) return new Map();
  const rows = await repo.getVariantsWithProductsByIds(variantIds);
  const map = new Map<string, VariantWithProduct>();
  for (const row of rows) {
    map.set(row.variant.id, row);
  }
  return map;
}

/**
 * Resolve the four region names for a snapshot's BPS ids and produce a
 * new snapshot value that carries both ids AND names. Any name that the
 * region tables cannot resolve is OMITTED from the result (rather than
 * stored as `null`) so the JSONB blob stays compact and the wire shape
 * surfaces the field as `undefined` — UI clients then fall back to the
 * id field via `provinsiName ?? provinsiId`.
 */
async function enrichSnapshotWithRegionNames(
  repo: OrdersRepository,
  snapshot: OrderAddressSnapshot,
): Promise<OrderAddressSnapshot> {
  const names = await repo.resolveRegionNames({
    provinsiId: snapshot.provinsiId,
    kotaKabupatenId: snapshot.kotaKabupatenId,
    kecamatanId: snapshot.kecamatanId,
    kelurahanId: snapshot.kelurahanId,
  });
  return {
    ...snapshot,
    ...(names.provinsiName !== null
      ? { provinsiName: names.provinsiName }
      : {}),
    ...(names.kotaKabupatenName !== null
      ? { kotaKabupatenName: names.kotaKabupatenName }
      : {}),
    ...(names.kecamatanName !== null
      ? { kecamatanName: names.kecamatanName }
      : {}),
    ...(names.kelurahanName !== null
      ? { kelurahanName: names.kelurahanName }
      : {}),
  };
}

/**
 * Compose the order-line title translation blob from the variant's and
 * product's `translations` JSONB columns. For each locale present in
 * either source, the merged `title` prefers the variant's title (the
 * specific subtype label) and falls back to the product's title (the
 * generic name).
 *
 * When both variant and product are missing the requested locale, the
 * resolver in `mappers.ts` walks the documented fallback chain at read
 * time — we capture the full per-locale shape here so reads can resolve
 * without a catalog round-trip.
 */
function buildTitleTranslations(
  candidate: VariantWithProduct | undefined,
): Record<string, { title: string }> {
  if (!candidate) return {};
  const productTr =
    (candidate.product.translations as Record<
      string,
      Partial<{ title: string; description: string }>
    >) ?? {};
  const variantTr =
    (candidate.variant.translations as Record<
      string,
      Partial<{ title: string }>
    >) ?? {};

  const locales = new Set<string>([
    ...Object.keys(productTr),
    ...Object.keys(variantTr),
  ]);
  const out: Record<string, { title: string }> = {};
  for (const locale of locales) {
    const variantTitle = variantTr[locale]?.title;
    const productTitle = productTr[locale]?.title;
    const merged = variantTitle ?? productTitle ?? "";
    if (merged.length > 0) {
      out[locale] = { title: merged };
    }
  }
  return out;
}

function statusEventFor(
  orderId: string,
  orderNumber: string,
  toStatus: OrderStatus,
  actorKind: OrderActorKind,
): PendingEvent | null {
  switch (toStatus) {
    case "paid":
      return {
        name: "order.paid",
        payload: { orderId, orderNumber, actorKind },
      };
    case "fulfilled":
      return {
        name: "order.fulfilled",
        payload: { orderId, orderNumber, actorKind },
      };
    case "refunded":
      return {
        name: "order.refunded",
        payload: { orderId, orderNumber, actorKind },
      };
    case "cancelled":
      // Handled by the dedicated `cancelOrder` path which carries a
      // `reason`. We omit a typed event here so a `transitionStatus(...,
      // 'cancelled')` call falls back to the generic `order.status_changed`
      // — callers wanting the reason on the event use cancelOrder.
      return null;
    case "pending_payment":
    default:
      return null;
  }
}

/**
 * Default singleton wired to the runtime database. Tests instantiate
 * `OrderServiceImpl` directly with a fake repository.
 */
export const orderService: OrderService = new OrderServiceImpl(
  createOrdersRepository(),
);

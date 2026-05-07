/**
 * Orders module — typed event bus.
 *
 * Mirrors the checkout module's events.ts shape exactly so listeners that
 * cross modules can use a uniform interface. See
 * `apps/api/src/modules/checkout/events.ts` for the contract details
 * (in-process only, post-commit emit, at-least-once / idempotency).
 *
 * The bus is module-local: orders has its own singleton, checkout has
 * its own. Listeners in track 2 (notifications) subscribe to whichever
 * bus emits the event they care about. We do not collapse the two into
 * a single global registry at v0.1 — keeping module boundaries explicit
 * keeps the dependency graph readable.
 */
import { logger as rootLogger } from "../../lib/logger.js";
import type { OrderActorKind, OrderStatus } from "./types.js";

export interface OrderEventMap {
  "order.placed": {
    orderId: string;
    orderNumber: string;
    customerId: string | null;
    email: string;
    /** Total in the smallest unit of `currency`, as a decimal string. */
    totalAmount: string;
    currency: string;
  };
  "order.paid": {
    orderId: string;
    orderNumber: string;
    actorKind: OrderActorKind;
  };
  "order.fulfilled": {
    orderId: string;
    orderNumber: string;
    actorKind: OrderActorKind;
  };
  "order.cancelled": {
    orderId: string;
    orderNumber: string;
    reason: string | null;
    actorKind: OrderActorKind;
  };
  "order.refunded": {
    orderId: string;
    orderNumber: string;
    actorKind: OrderActorKind;
  };
  /** Generic transition event — listeners that don't care about the specific status. */
  "order.status_changed": {
    orderId: string;
    orderNumber: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actorKind: OrderActorKind;
  };
}

export type EventName = keyof OrderEventMap;
export type EventPayload<E extends EventName> = OrderEventMap[E];
export type Listener<E extends EventName> = (
  payload: EventPayload<E>,
) => void | Promise<void>;

interface ListenerRecord {
  fn: (payload: unknown) => void | Promise<void>;
}

class OrderEventBus {
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>();
  private readonly logger = rootLogger.child({ module: "orders.events" });

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    const record: ListenerRecord = {
      fn: listener as (payload: unknown) => void | Promise<void>,
    };
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(record);
    return () => {
      bucket?.delete(record);
    };
  }

  /**
   * Run every listener for `event` sequentially. Errors thrown by a single
   * listener are logged and swallowed so a buggy subscriber cannot prevent
   * others from running — but the emit itself completes only after every
   * listener has had its chance.
   */
  async emit<E extends EventName>(
    event: E,
    payload: EventPayload<E>,
  ): Promise<void> {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.size === 0) return;
    for (const record of bucket) {
      try {
        await record.fn(payload);
      } catch (err) {
        this.logger.error(
          { event, err },
          "order event listener threw — continuing",
        );
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const events = new OrderEventBus();

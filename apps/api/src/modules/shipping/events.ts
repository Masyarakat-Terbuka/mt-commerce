/**
 * Shipping module — typed event bus.
 *
 * Mirrors the orders/checkout module event bus exactly so cross-module
 * listeners can use a uniform interface. See `modules/orders/events.ts`
 * for the contract details (in-process only, post-commit emit,
 * at-least-once / idempotency).
 *
 * The bus is module-local: shipping has its own singleton, orders has its
 * own. Notification / reporting listeners subscribe to whichever bus emits
 * the event they care about.
 */
import { logger as rootLogger } from "../../lib/logger.js";
import type { FulfillmentActorKind, FulfillmentStatus } from "./types.js";

export interface FulfillmentEventMap {
  /** Emitted when a fulfillment is materialised (typically on `order.paid`). */
  "fulfillment.created": {
    fulfillmentId: string;
    orderId: string;
    shippingMethodId: string;
  };
  "fulfillment.shipped": {
    fulfillmentId: string;
    orderId: string;
    trackingCode: string | null;
    actorKind: FulfillmentActorKind;
  };
  "fulfillment.delivered": {
    fulfillmentId: string;
    orderId: string;
    actorKind: FulfillmentActorKind;
  };
  "fulfillment.cancelled": {
    fulfillmentId: string;
    orderId: string;
    reason: string | null;
    actorKind: FulfillmentActorKind;
  };
  /** Generic transition event — listeners that don't care about the specific status. */
  "fulfillment.status_changed": {
    fulfillmentId: string;
    orderId: string;
    fromStatus: FulfillmentStatus | null;
    toStatus: FulfillmentStatus;
    actorKind: FulfillmentActorKind;
  };
}

export type EventName = keyof FulfillmentEventMap;
export type EventPayload<E extends EventName> = FulfillmentEventMap[E];
export type Listener<E extends EventName> = (
  payload: EventPayload<E>,
) => void | Promise<void>;

interface ListenerRecord {
  fn: (payload: unknown) => void | Promise<void>;
}

class FulfillmentEventBus {
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>();
  private readonly logger = rootLogger.child({ module: "shipping.events" });

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
          "fulfillment event listener threw — continuing",
        );
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const events = new FulfillmentEventBus();

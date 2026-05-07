/**
 * Tiny typed event bus — in-process pub/sub.
 *
 * Per ARCHITECTURE.md "Background jobs and events", lightweight cross-module
 * reactions inside the same process use a typed event bus. The full project
 * does not yet have one (Cart was hermetic; Customer was hermetic), so this
 * module ships the stub and is the first consumer.
 *
 * Design constraints, picked deliberately for v0.1:
 *
 *   - In-process only. No Redis, no BullMQ. Critical workflows that MUST
 *     NOT be lost (e.g. fulfillment kicked off by `checkout.completed`)
 *     should ALSO enqueue a BullMQ job rather than relying on this bus —
 *     the bus is a notification mechanism, not a guarantee.
 *
 *   - Listeners run sequentially under the emitting `await`. A slow or
 *     throwing listener slows down or fails the emit. We catch+log per
 *     listener so one bad subscriber cannot poison the others, but we
 *     intentionally keep the API "fire and wait" rather than "fire and
 *     forget" so tests can assert ordering deterministically.
 *
 *   - Typed event map. Adding a new event = extending `EventMap`; the
 *     compiler then forces every emitter and listener to agree on the
 *     payload shape. No runtime schema; the types are the contract.
 *
 * Future work (out of scope here, documented in the README):
 *   - Move to a persistent backend (BullMQ) for events that must not be lost.
 *   - Add per-listener telemetry hooks.
 */
import { logger as rootLogger } from "../../lib/logger.js";

/**
 * Event payload map. Add new events here; emitters and listeners stay
 * type-safe across the codebase.
 */
export interface CheckoutEventMap {
  "checkout.started": { checkoutId: string; cartId: string };
  "checkout.shipping_set": {
    checkoutId: string;
    shippingMethodCode: string;
  };
  "checkout.payment_initiated": {
    checkoutId: string;
    paymentMethod: string;
  };
  "checkout.completed": {
    checkoutId: string;
    orderIntentId: string;
    cartId: string;
  };
  "checkout.failed": {
    checkoutId: string;
    reason: string | null;
  };
}

export type EventMap = CheckoutEventMap;

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];
export type Listener<E extends EventName> = (
  payload: EventPayload<E>,
) => void | Promise<void>;

interface ListenerRecord {
  // Stored as `unknown` so the registry can hold listeners across event
  // names. The public `on/emit` API rebinds the type per call.
  fn: (payload: unknown) => void | Promise<void>;
}

class EventBus {
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>();
  private readonly logger = rootLogger.child({ module: "events" });

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
          "event listener threw — continuing",
        );
      }
    }
  }

  /** Test helper. Drops every listener under every event name. */
  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Singleton bus. Modules import this directly. Tests can `events.clear()`
 * in a `beforeEach` to keep cross-test pollution out.
 */
export const events = new EventBus();

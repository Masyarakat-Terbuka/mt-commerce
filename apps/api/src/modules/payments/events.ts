/**
 * Payments module — typed event bus.
 *
 * Mirrors the orders/checkout module event-bus shape exactly so
 * cross-module listeners use a uniform interface. See
 * `apps/api/src/modules/orders/events.ts` for the contract details
 * (in-process only, post-commit emit, at-least-once / idempotency).
 */
import { logger as rootLogger } from "../../lib/logger.js";
import type { PaymentStatus } from "./state.js";

export interface PaymentEventMap {
  "payment.initiated": {
    paymentId: string;
    orderId: string;
    provider: string;
    /** Outcome variant the provider returned. */
    outcome: "redirect" | "captured" | "pending";
  };
  "payment.captured": {
    paymentId: string;
    orderId: string;
    provider: string;
  };
  "payment.failed": {
    paymentId: string;
    orderId: string;
    provider: string;
    /** Free-form reason the provider gave (or our own internal reason). */
    reason: string | null;
  };
  "payment.refunded": {
    paymentId: string;
    orderId: string;
    provider: string;
  };
  /** Generic transition event — listeners that don't care about the specific status. */
  "payment.status_changed": {
    paymentId: string;
    orderId: string;
    fromStatus: PaymentStatus;
    toStatus: PaymentStatus;
  };
}

export type EventName = keyof PaymentEventMap;
export type EventPayload<E extends EventName> = PaymentEventMap[E];
export type Listener<E extends EventName> = (
  payload: EventPayload<E>,
) => void | Promise<void>;

interface ListenerRecord {
  fn: (payload: unknown) => void | Promise<void>;
}

class PaymentEventBus {
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>();
  private readonly logger = rootLogger.child({ module: "payments.events" });

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
   * Run every listener for `event` sequentially. Errors thrown by a
   * single listener are logged and swallowed so a buggy subscriber
   * cannot prevent others from running.
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
          "payment event listener threw — continuing",
        );
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const events = new PaymentEventBus();

/**
 * Plugin-facing event bridge.
 *
 * The api's event buses are module-local — `apps/api/src/modules/checkout/events.ts`
 * holds its own singleton, `.../orders/events.ts` holds another. Plugins
 * see a single unified `on<E extends DomainEventName>(event, listener)`
 * surface from `@mt-commerce/core/plugin`; this file routes those
 * subscriptions to the right module bus by inspecting the event name's
 * dot-prefix.
 *
 * Why a bridge rather than a single global bus:
 *
 *   - Module locality. Modules emit on their own bus and reason about
 *     listener concurrency at the module boundary. A single global bus
 *     forces every emit to consider every other module's listeners,
 *     and would invert the dependency arrow (the events module would
 *     need to know about every event-shape).
 *
 *   - Type safety. The bridge's `on` takes `DomainEventName` from core,
 *     which is the union of every module's event shape. The bridge
 *     narrows on the dot-prefix and casts to the module bus's local
 *     `EventName`. The cast is local and defensive — adding a new event
 *     prefix without a corresponding case below fails at boot rather
 *     than silently dropping the listener.
 *
 *   - Testability. Tests can subscribe via this bridge to assert the
 *     plugin loader wires listeners through the right bus, without
 *     reaching into module internals.
 */
import type {
  DomainEventName,
  DomainEventPayload,
} from "@mt-commerce/core/plugin";
import { events as checkoutEvents } from "../modules/checkout/events.js";
import { events as orderEvents } from "../modules/orders/events.js";

type AnyListener = (payload: unknown) => void | Promise<void>;

/**
 * Subscribe a plugin listener to a domain event. Returns the unsubscribe
 * function returned by the underlying module bus.
 *
 * Routing:
 *   - `"checkout.*"` → checkout module bus
 *   - `"order.*"`    → orders module bus
 *
 * Unknown prefixes throw at registration time so a plugin author who
 * mis-spells `"orders.placed"` (extra `s`) gets a boot-time error rather
 * than a silently-never-fires listener.
 */
export function subscribePluginListener<E extends DomainEventName>(
  event: E,
  listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
): () => void {
  const wrapped = listener as AnyListener;
  if (event.startsWith("checkout.")) {
    // The checkout bus's `on` is generic over its own EventName union; we
    // assert the cast here because the bridge has already validated the
    // prefix and the payload shape was matched at the type level by the
    // caller's `E` parameter.
    return checkoutEvents.on(
      event as Parameters<typeof checkoutEvents.on>[0],
      wrapped as Parameters<typeof checkoutEvents.on>[1],
    );
  }
  if (event.startsWith("order.")) {
    return orderEvents.on(
      event as Parameters<typeof orderEvents.on>[0],
      wrapped as Parameters<typeof orderEvents.on>[1],
    );
  }
  throw new Error(
    `Unknown plugin event prefix on "${event}". Expected one of: "checkout.*", "order.*". ` +
      `If a new module added an event, extend "apps/api/src/lib/plugin-events.ts".`,
  );
}

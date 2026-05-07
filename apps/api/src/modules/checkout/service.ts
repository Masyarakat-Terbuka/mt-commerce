/**
 * `CheckoutService` — public contract for the checkout module.
 *
 * Owns:
 *   - the state machine: every transition is gated by `canTransition` from
 *     `state.ts`. The service refuses moves the diagram does not allow,
 *     surfacing `ConflictError` with `details.code = "invalid_transition"`.
 *   - audit-logging: every successful transition writes a `checkout_events`
 *     row in the same unit of work as the state change.
 *   - terminal behavior: completing a checkout snapshots the cart + totals
 *     + addresses, writes an `order_intent`, marks the cart `converted`,
 *     and emits `checkout.completed` — atomically. The placeholder
 *     `order_intent` row is the contract the future Order module will
 *     consume.
 *   - cancellation: any non-terminal state may move to `failed` with an
 *     optional reason; emits `checkout.failed`.
 *
 * Constructor takes a repository and a `CartService`-shaped totals
 * computer so tests can swap fakes for both. The default singleton wires
 * to the runtime DB and the live cart service.
 */
import {
  add as moneyAdd,
  multiply as moneyMultiply,
  type Money,
} from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import { env } from "../../lib/env.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { childLogger } from "../../lib/logger.js";
import {
  cartService as defaultCartService,
  type Cart,
  type CartService,
  type CartTotals,
} from "../cart/index.js";
import {
  customerService as defaultCustomerService,
  type CustomerService,
} from "../customer/index.js";
import {
  shippingService as defaultShippingService,
  type ShippingService,
} from "../shipping/index.js";
import { events, type EventName, type EventPayload } from "./events.js";
import {
  toCheckout,
  toCheckoutEvent,
  toOrderIntent,
} from "./mappers.js";
import {
  createCheckoutRepository,
  type CheckoutRepository,
} from "./repository.js";
import { canTransition, isTerminal, type CheckoutState } from "./state.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type Checkout,
  type CheckoutEvent,
  type ListCheckoutsQuery,
  type OrderIntent,
  type OrderIntentAddress,
  type OrderIntentLine,
  type OrderIntentTotals,
  type Paginated,
  type StartCheckoutInput,
  type SetAddressesInput,
  type SetShippingInput,
} from "./types.js";

export interface CompleteCheckoutResult {
  checkout: Checkout;
  orderIntent: OrderIntent;
}

export interface CheckoutService {
  // Lifecycle
  startCheckout(input: StartCheckoutInput): Promise<Checkout>;
  getCheckout(id: string): Promise<Checkout | null>;
  setAddresses(
    checkoutId: string,
    input: SetAddressesInput,
  ): Promise<Checkout>;
  setShipping(
    checkoutId: string,
    input: SetShippingInput,
  ): Promise<Checkout>;
  /**
   * Atomic terminal write — see file header. The `idempotencyKey` is
   * captured on the checkout row; the request-level idempotency middleware
   * dedupes the HTTP layer.
   */
  complete(
    checkoutId: string,
    input: { paymentMethod: string; idempotencyKey: string | null },
  ): Promise<CompleteCheckoutResult>;
  cancel(
    checkoutId: string,
    input: { reason?: string | null },
  ): Promise<Checkout>;

  // Reads
  listCheckouts(query: ListCheckoutsQuery): Promise<Paginated<Checkout>>;
  listEvents(checkoutId: string): Promise<CheckoutEvent[]>;
}

/**
 * Captured event to fire AFTER the enclosing transaction commits. The
 * `name` literal narrows `payload` to the right shape; we hand-roll a
 * tagged union over `EventName` so a single typed array can hold any
 * event variant without losing type-safety.
 */
type PendingEvent = {
  [E in EventName]: { name: E; payload: EventPayload<E> };
}[EventName];

const log = childLogger("checkout");

export class CheckoutServiceImpl implements CheckoutService {
  constructor(
    private readonly repo: CheckoutRepository,
    private readonly carts: CartService,
    private readonly customers: CustomerService,
    private readonly shipping: ShippingService,
  ) {}

  /**
   * Fire pending events after `withTransaction` returns. Each listener is
   * awaited in order; the bus already catches per-listener throws so a
   * single bad subscriber cannot stop the rest. See `events.ts` for the
   * idempotency contract listeners must honor.
   */
  private async emitPending(pending: PendingEvent[]): Promise<void> {
    for (const ev of pending) {
      // Per-event narrowing: the generic emit signature requires the
      // payload type matches the event name. The PendingEvent union is
      // already correlated, so a per-iteration cast back to the matched
      // pair is safe.
      await (
        events.emit as <E extends EventName>(
          name: E,
          payload: EventPayload<E>,
        ) => Promise<void>
      )(ev.name, ev.payload);
    }
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async startCheckout(input: StartCheckoutInput): Promise<Checkout> {
    const cart = await this.carts.getCartById(input.cartId);
    if (!cart) {
      throw new NotFoundError("Cart not found.", { cartId: input.cartId });
    }
    if (cart.status !== "active") {
      throw new ConflictError("Cannot start a checkout from a non-active cart.", {
        cartId: cart.id,
        status: cart.status,
      });
    }
    if (cart.items.length === 0) {
      throw new ConflictError("Cannot start a checkout with an empty cart.", {
        cartId: cart.id,
      });
    }

    // Email is required for guest checkouts. Customer-bound carts inherit
    // the customer's email — the customer module owns identity, so we let
    // the route layer or an internal helper resolve it before getting here
    // for now. v0.1 treats the explicit `email` input as authoritative when
    // present and falls back to the customer record if available.
    let email: string | null = input.email ?? null;
    if (cart.customerId !== null) {
      const customer = await this.customers.getCustomerById(cart.customerId);
      if (!customer) {
        throw new NotFoundError(
          "Customer attached to the cart could not be loaded.",
          { customerId: cart.customerId },
        );
      }
      // Customer-bound: prefer the customer's email; the input.email is an
      // override only when explicitly different (use cases are rare; the
      // service does not currently enforce a match).
      email = email ?? customer.email;
    } else if (!email) {
      throw new ValidationError(
        "email is required for guest checkouts.",
        { code: "guest_email_required", cartId: cart.id },
      );
    }

    const checkoutId = id("chk");
    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const row = await tx.insertCheckout({
        id: checkoutId,
        cartId: cart.id,
        customerId: cart.customerId,
        state: "pending",
        email,
      });
      await tx.insertEvent({
        id: id("cke"),
        checkoutId,
        fromState: null,
        toState: "pending",
        details: { cartId: cart.id },
      });
      const pendingEvents: PendingEvent[] = [
        {
          name: "checkout.started",
          payload: { checkoutId, cartId: cart.id },
        },
      ];
      return { result: toCheckout(row), pending: pendingEvents };
    });
    await this.emitPending(pending);
    return result;
  }

  async getCheckout(checkoutId: string): Promise<Checkout | null> {
    const row = await this.repo.getCheckoutById(checkoutId);
    return row ? toCheckout(row) : null;
  }

  async setAddresses(
    checkoutId: string,
    input: SetAddressesInput,
  ): Promise<Checkout> {
    const row = await this.repo.getCheckoutById(checkoutId);
    if (!row) {
      throw new NotFoundError("Checkout not found.", { checkoutId });
    }
    const current = row.state as CheckoutState;
    // Accept from `pending` (forward) and from awaiting_shipping /
    // awaiting_payment (revisions).
    const next: CheckoutState = "awaiting_shipping";
    if (
      current !== "pending" &&
      current !== "awaiting_shipping" &&
      current !== "awaiting_payment"
    ) {
      throw new ConflictError("Addresses cannot be changed in this state.", {
        code: "invalid_transition",
        from: current,
        to: next,
      });
    }
    if (!canTransition(current, next)) {
      // Defense-in-depth — `awaiting_payment → awaiting_shipping` IS allowed
      // (revision); this guard catches a future state being added without
      // the table being updated.
      throw new ConflictError("Invalid checkout state transition.", {
        code: "invalid_transition",
        from: current,
        to: next,
      });
    }

    // Address ownership: when the checkout has a customer, every address
    // referenced must belong to that customer. Guest checkouts have no
    // address book yet (TODO — see README); we reject the call with a
    // documented error so the caller can route to the guest-address flow
    // when it lands.
    if (row.customerId === null) {
      throw new ConflictError(
        "Guest checkouts cannot select customer addresses.",
        {
          code: "guest_address_unsupported",
          checkoutId,
        },
      );
    }

    await this.assertAddressOwnership(input.shippingAddressId, row.customerId);
    if (input.billingAddressId) {
      await this.assertAddressOwnership(input.billingAddressId, row.customerId);
    }

    // S11: when transitioning back from `awaiting_payment`, the stale
    // shipping selection is no longer authoritative — the user is
    // revising. Clear it so a follow-up read does not surface a method
    // and amount that no longer match the (possibly different) address.
    const isRevision = current === "awaiting_payment";

    return this.repo.withTransaction(async (tx) => {
      const updated = await tx.updateCheckout(checkoutId, {
        state: next,
        shippingAddressId: input.shippingAddressId,
        billingAddressId: input.billingAddressId ?? null,
        ...(isRevision
          ? {
              shippingMethodCode: null,
              shippingAmount: null,
              shippingCurrency: null,
            }
          : {}),
      });
      if (!updated) {
        throw new NotFoundError("Checkout not found.", { checkoutId });
      }
      await tx.insertEvent({
        id: id("cke"),
        checkoutId,
        fromState: current,
        toState: next,
        details: {
          shippingAddressId: input.shippingAddressId,
          billingAddressId: input.billingAddressId ?? null,
          ...(isRevision ? { revisedFromAwaitingPayment: true } : {}),
        },
      });
      return toCheckout(updated);
    });
  }

  async setShipping(
    checkoutId: string,
    input: SetShippingInput,
  ): Promise<Checkout> {
    const row = await this.repo.getCheckoutById(checkoutId);
    if (!row) {
      throw new NotFoundError("Checkout not found.", { checkoutId });
    }
    const current = row.state as CheckoutState;
    const next: CheckoutState = "awaiting_payment";
    if (
      current !== "awaiting_shipping" &&
      current !== "awaiting_payment"
    ) {
      throw new ConflictError(
        "Shipping can only be set after addresses are chosen.",
        { code: "invalid_transition", from: current, to: next },
      );
    }
    if (!canTransition(current, next)) {
      throw new ConflictError("Invalid checkout state transition.", {
        code: "invalid_transition",
        from: current,
        to: next,
      });
    }

    // Currency parity: the cart locks a single currency at first item add.
    // Shipping must be in the same currency or the total cannot be a
    // single Money value. We re-load the cart to enforce this.
    const cart = await this.carts.getCartById(row.cartId);
    if (!cart) {
      throw new NotFoundError("Underlying cart not found.", {
        cartId: row.cartId,
      });
    }

    // Resolve the amount via the shipping module's `quote()` rather than
    // trusting the client. The shipping service:
    //   - 404s if the method code is unknown or soft-deleted
    //   - 409s if the method exists but is inactive
    //   - 400 (validation_error / currency_mismatch) when the method's
    //     currency differs from the cart's currency
    // All three already wear the standard error envelope; we let them
    // surface unchanged so callers see consistent error codes.
    const shippingAmount = await this.shipping.quote({
      methodCode: input.shippingMethodCode,
      currency: cart.currency,
    });
    // Defense-in-depth: the shipping service asserts currency parity
    // already, but we re-check at the boundary so a misbehaving provider
    // cannot smuggle a wrong-currency amount onto the checkout row.
    if (shippingAmount.currency !== cart.currency) {
      throw new ValidationError(
        "Shipping currency does not match the cart's currency.",
        {
          code: "currency_mismatch",
          cartCurrency: cart.currency,
          shippingCurrency: shippingAmount.currency,
        },
      );
    }
    if (shippingAmount.amount < 0n) {
      throw new ValidationError("Shipping amount must be non-negative.", {
        amount: shippingAmount.amount.toString(),
      });
    }

    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const updated = await tx.updateCheckout(checkoutId, {
        state: next,
        shippingMethodCode: input.shippingMethodCode,
        shippingAmount: shippingAmount.amount,
        shippingCurrency: shippingAmount.currency,
      });
      if (!updated) {
        throw new NotFoundError("Checkout not found.", { checkoutId });
      }
      await tx.insertEvent({
        id: id("cke"),
        checkoutId,
        fromState: current,
        toState: next,
        details: {
          shippingMethodCode: input.shippingMethodCode,
          shippingAmount: shippingAmount.amount.toString(),
          shippingCurrency: shippingAmount.currency,
        },
      });
      const pendingEvents: PendingEvent[] = [
        {
          name: "checkout.shipping_set",
          payload: {
            checkoutId,
            shippingMethodCode: input.shippingMethodCode,
          },
        },
      ];
      return { result: toCheckout(updated), pending: pendingEvents };
    });
    await this.emitPending(pending);
    return result;
  }

  async complete(
    checkoutId: string,
    input: { paymentMethod: string; idempotencyKey: string | null },
  ): Promise<CompleteCheckoutResult> {
    const row = await this.repo.getCheckoutById(checkoutId);
    if (!row) {
      throw new NotFoundError("Checkout not found.", { checkoutId });
    }
    const current = row.state as CheckoutState;
    if (current !== "awaiting_payment") {
      throw new ConflictError(
        "Checkout must be in awaiting_payment to complete.",
        { code: "invalid_transition", from: current, to: "completed" },
      );
    }
    if (!canTransition(current, "completed")) {
      throw new ConflictError("Invalid checkout state transition.", {
        code: "invalid_transition",
        from: current,
        to: "completed",
      });
    }
    if (!row.shippingAddressId) {
      throw new ConflictError("Checkout has no shipping address.", {
        checkoutId,
      });
    }
    if (!row.shippingMethodCode || row.shippingAmount === null || row.shippingCurrency === null) {
      throw new ConflictError("Checkout has no shipping selection.", {
        checkoutId,
      });
    }
    if (!row.email) {
      // Defense-in-depth — `startCheckout` enforces this, but we re-check
      // before writing a permanent order_intent row.
      throw new ConflictError("Checkout has no email captured.", {
        checkoutId,
      });
    }

    // Surface the placeholder so reviewers know the boundary.
    // Issue payment-not-implemented detection upstream once the payment
    // module ships; for v0.1 we treat the call as authoritative ("the
    // payment was captured by some out-of-band step, mark this complete").
    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      // Re-fetch UNDER A ROW LOCK (`SELECT ... FOR UPDATE`). Two parallel
      // `complete()` calls would, under READ COMMITTED, both observe
      // `state='awaiting_payment'` from a plain SELECT and both proceed
      // to insert an `order_intent` — the loser would then hit the
      // `order_intents_checkout_id_unique` constraint as a raw 23505.
      // The row lock serialises the mutators: the second waiter blocks
      // until the first commits, then sees `state='completed'` and
      // surfaces a `ConflictError` cleanly.
      const fresh = await tx.getCheckoutByIdForUpdate(checkoutId);
      if (!fresh) {
        throw new NotFoundError("Checkout not found.", { checkoutId });
      }
      if (fresh.state !== "awaiting_payment") {
        // The same `already_completed` code is used for both the
        // "racer-already-completed" and "raw unique-violation
        // belt-and-suspenders" paths so callers can treat them
        // uniformly.
        if (fresh.state === "completed") {
          throw new ConflictError(
            "Checkout has already been completed.",
            { code: "already_completed", checkoutId },
          );
        }
        throw new ConflictError(
          "Checkout state changed under the request — refusing to complete.",
          {
            code: "invalid_transition",
            from: fresh.state,
            to: "completed",
          },
        );
      }

      // Snapshot the cart + totals + addresses.
      const snapshot = await tx.getCartSnapshotForCompletion(fresh.cartId);
      if (!snapshot) {
        throw new NotFoundError("Underlying cart not found.", {
          cartId: fresh.cartId,
        });
      }
      // S10: a cart that was emptied between `setShipping` and `complete`
      // would otherwise produce a zero-total order_intent and still mark
      // the cart converted. Refuse explicitly.
      if (snapshot.items.length === 0) {
        throw new ConflictError(
          "Cart is empty; cannot complete checkout.",
          { code: "cart_empty", checkoutId, cartId: fresh.cartId },
        );
      }
      const cart = await this.carts.getCartById(fresh.cartId);
      if (!cart) {
        throw new NotFoundError("Underlying cart not found.", {
          cartId: fresh.cartId,
        });
      }
      const cartTotals = this.carts.getTotals(cart);
      const shippingMoney: Money = {
        amount: fresh.shippingAmount as bigint,
        currency: fresh.shippingCurrency as string,
      };
      // Add the captured shipping to the cart's totals to produce the
      // final totals snapshot stored on the order_intent. The cart-level
      // totals carry a zero shipping placeholder; we replace it here.
      const completedTotals = mergeShippingIntoTotals(cartTotals, shippingMoney);

      const shippingAddrRow = await tx.getAddressForSnapshot(
        fresh.shippingAddressId as string,
      );
      if (!shippingAddrRow) {
        throw new NotFoundError("Shipping address not found.", {
          addressId: fresh.shippingAddressId,
        });
      }
      const billingAddrRow = fresh.billingAddressId
        ? await tx.getAddressForSnapshot(fresh.billingAddressId)
        : null;

      const cartSnapshotJson = snapshot.items.map((item): OrderIntentLine => ({
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice: {
          amount: item.unitPriceAmount,
          currency: item.unitPriceCurrency,
        },
      }));

      const orderIntentId = id("oint");
      let orderIntentRow;
      try {
        orderIntentRow = await tx.insertOrderIntent({
          id: orderIntentId,
          checkoutId,
          cartSnapshot: cartSnapshotJson.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
            // Serialize bigint as decimal string so the JSON column round-trips
            // through Postgres without precision loss.
            unitPrice: {
              amount: line.unitPrice.amount.toString(),
              currency: line.unitPrice.currency,
            },
          })),
          totalsSnapshot: serializeTotals(completedTotals),
          shippingAddressSnapshot: addressToSnapshotJson(shippingAddrRow),
          billingAddressSnapshot: billingAddrRow
            ? addressToSnapshotJson(billingAddrRow)
            : null,
          email: fresh.email as string,
          shippingMethodCode: fresh.shippingMethodCode as string,
          paymentMethod: input.paymentMethod,
        });
      } catch (err) {
        // Belt-and-suspenders: even with the FOR UPDATE lock above, a
        // raw 23505 on `order_intents_checkout_id_unique` should never
        // surface as a 500. Reclassify as `already_completed`.
        if (isPostgresUniqueViolation(err, "order_intents_checkout_id_unique")) {
          throw new ConflictError(
            "Checkout has already been completed.",
            { code: "already_completed", checkoutId },
          );
        }
        throw err;
      }

      // Mark the cart converted (cross-module write — see repo header).
      await tx.markCartConverted(fresh.cartId);

      const updated = await tx.updateCheckout(checkoutId, {
        state: "completed",
        paymentMethod: input.paymentMethod,
        idempotencyKey: input.idempotencyKey,
      });
      if (!updated) {
        throw new NotFoundError("Checkout not found.", { checkoutId });
      }
      await tx.insertEvent({
        id: id("cke"),
        checkoutId,
        fromState: "awaiting_payment",
        toState: "completed",
        details: {
          paymentMethod: input.paymentMethod,
          orderIntentId,
        },
      });

      // Events fire AFTER commit — listeners that reach the DB would
      // otherwise observe a checkout that does not exist if the
      // transaction were to roll back between emit and commit. See
      // `events.ts` for the at-least-once / idempotency contract.
      const pendingEvents: PendingEvent[] = [
        {
          name: "checkout.payment_initiated",
          payload: {
            checkoutId,
            paymentMethod: input.paymentMethod,
          },
        },
        {
          name: "checkout.completed",
          payload: {
            checkoutId,
            orderIntentId,
            cartId: fresh.cartId,
          },
        },
      ];

      return {
        result: {
          checkout: toCheckout(updated),
          orderIntent: toOrderIntent(orderIntentRow),
        },
        pending: pendingEvents,
      };
    });
    await this.emitPending(pending);
    return result;
  }

  async cancel(
    checkoutId: string,
    input: { reason?: string | null },
  ): Promise<Checkout> {
    const row = await this.repo.getCheckoutById(checkoutId);
    if (!row) {
      throw new NotFoundError("Checkout not found.", { checkoutId });
    }
    const current = row.state as CheckoutState;
    if (isTerminal(current)) {
      throw new ConflictError("Checkout is already terminal.", {
        code: "invalid_transition",
        from: current,
        to: "failed",
      });
    }

    const { result, pending } = await this.repo.withTransaction(async (tx) => {
      const updated = await tx.updateCheckout(checkoutId, {
        state: "failed",
        cancellationReason: input.reason ?? null,
      });
      if (!updated) {
        throw new NotFoundError("Checkout not found.", { checkoutId });
      }
      await tx.insertEvent({
        id: id("cke"),
        checkoutId,
        fromState: current,
        toState: "failed",
        details: {
          reason: input.reason ?? null,
        },
      });
      const pendingEvents: PendingEvent[] = [
        {
          name: "checkout.failed",
          payload: {
            checkoutId,
            reason: input.reason ?? null,
          },
        },
      ];
      return { result: toCheckout(updated), pending: pendingEvents };
    });
    await this.emitPending(pending);
    return result;
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async listCheckouts(
    query: ListCheckoutsQuery,
  ): Promise<Paginated<Checkout>> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    const { rows, total } = await this.repo.listCheckouts({
      ...(query.state ? { state: query.state } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      page,
      pageSize,
    });

    return {
      data: rows.map(toCheckout),
      total,
      page,
      pageSize,
    };
  }

  async listEvents(checkoutId: string): Promise<CheckoutEvent[]> {
    const rows = await this.repo.listEvents(checkoutId);
    return rows.map(toCheckoutEvent);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Fail-loud ownership check. The customer service exposes
   * `getAddressById`; we re-use the public surface so the checkout module
   * never reaches into the customer module's internals.
   */
  private async assertAddressOwnership(
    addressId: string,
    customerId: string,
  ): Promise<void> {
    const addr = await this.customers.getAddressById(addressId);
    if (!addr) {
      throw new NotFoundError("Address not found.", { addressId });
    }
    if (addr.customerId !== customerId) {
      // Refuse explicitly; surfacing as 403 would leak existence of
      // foreign-customer rows. 404-style is intentional.
      throw new NotFoundError(
        "Address does not belong to this checkout's customer.",
        { addressId },
      );
    }
    if (addr.deletedAt !== null) {
      throw new ConflictError("Cannot use a deleted address.", {
        addressId,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Replace the placeholder `shipping = zero` produced by the cart's totals
 * computation with the real shipping captured at the `awaiting_payment`
 * transition, then re-derive the total. Tax is unchanged.
 */
function mergeShippingIntoTotals(
  cartTotals: CartTotals,
  shipping: Money,
): OrderIntentTotals {
  const total = moneyAdd(moneyAdd(cartTotals.subtotal, cartTotals.tax), shipping);
  // Defense-in-depth: re-derive the cart's tax using the same flat-rate
  // placeholder so that a future divergence in `getTotals` cannot silently
  // drift the snapshot. v0.1 has a single tax module placeholder; the real
  // tax module will replace this whole helper.
  const recomputedTax = moneyMultiply(cartTotals.subtotal, env.taxPpnRate, {
    rounding: "halfEven",
  });
  // Sanity check — if the cart's totals diverge from the recomputation by
  // more than a rounding cent, surface it as a programming error.
  if (recomputedTax.amount !== cartTotals.tax.amount) {
    // We do NOT throw here — the cart layer is the source of truth for
    // tax in v0.1. Log the divergence so operators can see it and the
    // future tax module can be tuned. (The real tax module replaces
    // this placeholder.)
    log.warn(
      {
        recomputed: {
          amount: recomputedTax.amount.toString(),
          currency: recomputedTax.currency,
        },
        stored: {
          amount: cartTotals.tax.amount.toString(),
          currency: cartTotals.tax.currency,
        },
      },
      "tax divergence detected at completion",
    );
  }
  return {
    subtotal: cartTotals.subtotal,
    tax: cartTotals.tax,
    shipping,
    total,
  };
}

function serializeTotals(totals: OrderIntentTotals): Record<string, unknown> {
  return {
    subtotal: { amount: totals.subtotal.amount.toString(), currency: totals.subtotal.currency },
    tax: { amount: totals.tax.amount.toString(), currency: totals.tax.currency },
    shipping: { amount: totals.shipping.amount.toString(), currency: totals.shipping.currency },
    total: { amount: totals.total.amount.toString(), currency: totals.total.currency },
  };
}

function addressToSnapshotJson(
  row: {
    id: string;
    customerId: string;
    kind: string;
    recipientName: string;
    phone: string;
    addressLine1: string;
    addressLine2: string | null;
    provinsiId: string;
    kotaKabupatenId: string;
    kecamatanId: string;
    kelurahanId: string | null;
    postalCode: string;
    notes: string | null;
  },
): OrderIntentAddress {
  return {
    id: row.id,
    customerId: row.customerId,
    kind: row.kind === "billing" ? "billing" : "shipping",
    recipientName: row.recipientName,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2 ?? null,
    provinsiId: row.provinsiId,
    kotaKabupatenId: row.kotaKabupatenId,
    kecamatanId: row.kecamatanId,
    kelurahanId: row.kelurahanId ?? null,
    postalCode: row.postalCode,
    notes: row.notes ?? null,
  };
}

/**
 * Narrow on the postgres-js (and node-postgres) `code` SQLSTATE field.
 * `23505` is `unique_violation`. When a constraint name is provided we
 * also match `constraint_name`, which postgres-js exposes alongside the
 * code. Used to reclassify the `order_intents_checkout_id_unique` race
 * as a clean `ConflictError` rather than a 500.
 */
function isPostgresUniqueViolation(
  err: unknown,
  constraintName?: string,
): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as {
    code?: unknown;
    constraint_name?: unknown;
    constraint?: unknown;
  };
  if (candidate.code !== "23505") return false;
  if (!constraintName) return true;
  return (
    candidate.constraint_name === constraintName ||
    candidate.constraint === constraintName
  );
}

function clampPage(page: number | undefined): number {
  if (!page || page < 1) return 1;
  return Math.floor(page);
}

function clampPageSize(size: number | undefined): number {
  if (!size || size < 1) return DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(size);
}

/**
 * Default singleton wired to the runtime database and live cart, customer,
 * and shipping services. Tests construct `CheckoutServiceImpl` directly
 * with fakes.
 */
export const checkoutService: CheckoutService = new CheckoutServiceImpl(
  createCheckoutRepository(),
  defaultCartService,
  defaultCustomerService,
  defaultShippingService,
);

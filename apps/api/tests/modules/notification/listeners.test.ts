/**
 * Notification listeners — wires the three event-driven sends and the
 * idempotency / failure semantics around them.
 *
 * Strategy: construct `NotificationServiceImpl` with hand-rolled fakes for
 * the repository, channel registry, order service, and customer service.
 * Subscribe to the real (singleton) module event buses, emit fixture
 * events, and assert the channel saw the right rendered triple plus that
 * the audit row was written. Tests reset the buses' listener sets in
 * `beforeEach` so subscriptions from prior tests do not leak.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationServiceImpl } from "../../../src/modules/notification/service.js";
import type {
  NotificationListFilters,
  NotificationListResult,
  NotificationRepository,
} from "../../../src/modules/notification/repository.js";
import type {
  NewNotificationRow,
  NotificationRow,
} from "../../../src/db/schema/index.js";
import type {
  ChannelSendInput,
  NotificationChannel,
} from "../../../src/modules/notification/channels/types.js";
import type { NotificationChannelId } from "../../../src/modules/notification/types.js";
import { events as orderEvents } from "../../../src/modules/orders/events.js";
import { events as paymentEvents } from "../../../src/modules/payments/events.js";
import { events as fulfillmentEvents } from "../../../src/modules/shipping/events.js";
// Same circular-import discipline as `service.ts` — import from the type
// files directly so the test does not pull in the orders/customer route
// builders (and through them the auth middleware) just to type the fakes.
import type { Order } from "../../../src/modules/orders/types.js";
import type { OrderService } from "../../../src/modules/orders/service.js";
import type { CustomerService } from "../../../src/modules/customer/service.js";
import type {
  Customer,
  CustomerAddress,
} from "../../../src/modules/customer/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-08T12:00:00.000Z");

interface FakeStore {
  rows: Map<string, NotificationRow>;
  clock: number;
}

function createStore(): FakeStore {
  return { rows: new Map(), clock: 0 };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(NOW.getTime() + store.clock * 1000);
}

/**
 * Fake repository. Implements the `(event_id, kind, channel)` partial
 * unique index by raising a postgres-shaped error from `insert` when a
 * duplicate triple (with non-null event_id) is attempted — so the
 * idempotency guard in the service is exercised for real, not stubbed.
 */
function createFakeRepo(store: FakeStore): NotificationRepository {
  return {
    async insert(row: NewNotificationRow): Promise<NotificationRow> {
      // Enforce the partial unique index in the fake too — the service's
      // idempotency catch must trigger on this code path.
      if (row.eventId) {
        for (const existing of store.rows.values()) {
          if (
            existing.eventId === row.eventId &&
            existing.kind === row.kind &&
            existing.channel === row.channel
          ) {
            const err: Error & { code?: string; constraint_name?: string } =
              Object.assign(new Error("duplicate key"), {
                code: "23505",
                constraint_name: "notifications_event_kind_channel_uniq",
              });
            throw err;
          }
        }
      }
      const now = tick(store);
      const inserted: NotificationRow = {
        id: row.id,
        channel: row.channel,
        kind: row.kind,
        recipient: row.recipient,
        subject: row.subject ?? null,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        status: row.status ?? "pending",
        errorMessage: row.errorMessage ?? null,
        eventId: row.eventId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.rows.set(inserted.id, inserted);
      return inserted;
    },
    async getById(id: string): Promise<NotificationRow | null> {
      return store.rows.get(id) ?? null;
    },
    async getByEventTriple(eventId, kind, channel) {
      for (const row of store.rows.values()) {
        if (
          row.eventId === eventId &&
          row.kind === kind &&
          row.channel === channel
        ) {
          return row;
        }
      }
      return null;
    },
    async list(filters: NotificationListFilters): Promise<NotificationListResult> {
      let rows = Array.from(store.rows.values());
      if (filters.channel) rows = rows.filter((r) => r.channel === filters.channel);
      if (filters.kind) rows = rows.filter((r) => r.kind === filters.kind);
      if (filters.status) rows = rows.filter((r) => r.status === filters.status);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const total = rows.length;
      const offset = (filters.page - 1) * filters.pageSize;
      return { rows: rows.slice(offset, offset + filters.pageSize), total };
    },
    async markStatus(id, status, errorMessage): Promise<NotificationRow | null> {
      const existing = store.rows.get(id);
      if (!existing) return null;
      const updated: NotificationRow = {
        ...existing,
        status,
        errorMessage,
        updatedAt: tick(store),
      };
      store.rows.set(id, updated);
      return updated;
    },
  };
}

interface CapturingChannel extends NotificationChannel {
  calls: ChannelSendInput[];
}

function createCapturingChannel(channelId: NotificationChannelId): CapturingChannel {
  const calls: ChannelSendInput[] = [];
  return {
    id: channelId,
    async send(input) {
      calls.push(input);
    },
    calls,
  };
}

function createThrowingChannel(
  channelId: NotificationChannelId,
  message: string,
): NotificationChannel {
  return {
    id: channelId,
    async send() {
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: overrides.id ?? "ord_test_1",
    orderNumber: overrides.orderNumber ?? "ORD-2026-000001",
    customerId: overrides.customerId ?? "cust_a",
    email: overrides.email ?? "buyer@example.com",
    currency: overrides.currency ?? "IDR",
    status: overrides.status ?? "pending_payment",
    subtotal: overrides.subtotal ?? { amount: 500_000n, currency: "IDR" },
    tax: overrides.tax ?? { amount: 55_000n, currency: "IDR" },
    taxRateCode: overrides.taxRateCode ?? null,
    taxRateBasisPoints: overrides.taxRateBasisPoints ?? null,
    shipping: overrides.shipping ?? { amount: 10_000n, currency: "IDR" },
    shippingMethodCode: overrides.shippingMethodCode ?? "MANUAL_FLAT",
    total: overrides.total ?? { amount: 565_000n, currency: "IDR" },
    shippingAddressSnapshot: overrides.shippingAddressSnapshot ?? {
      id: "adr_1",
      customerId: "cust_a",
      kind: "shipping",
      recipientName: "Budi",
      phone: "+6281200001111",
      addressLine1: "Jl. Mawar 1",
      addressLine2: null,
      provinsiId: "31",
      kotaKabupatenId: "3171",
      kecamatanId: "317101",
      kelurahanId: null,
      provinsiName: "DKI Jakarta",
      kotaKabupatenName: "Jakarta Pusat",
      postalCode: "10110",
      notes: null,
    },
    billingAddressSnapshot: overrides.billingAddressSnapshot ?? null,
    paymentMethod: overrides.paymentMethod ?? "manual_bank_transfer",
    items: overrides.items ?? [
      {
        id: "oi_1",
        orderId: "ord_test_1",
        variantId: "var_1",
        sku: "SKU-VAR_1",
        title: "Kemeja Putih",
        quantity: 2,
        unitPrice: { amount: 250_000n, currency: "IDR" },
        lineSubtotal: { amount: 500_000n, currency: "IDR" },
        createdAt: NOW,
      },
    ],
    fulfillments: overrides.fulfillments ?? [],
    paidAt: overrides.paidAt ?? null,
    fulfilledAt: overrides.fulfilledAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    refundedAt: overrides.refundedAt ?? null,
    cancellationReason: overrides.cancellationReason ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: overrides.id ?? "cust_a",
    authUserId: overrides.authUserId ?? null,
    email: overrides.email ?? "buyer@example.com",
    displayName: overrides.displayName ?? "Budi Santoso",
    phone: overrides.phone ?? "+6281200001111",
    taxIdentifier: overrides.taxIdentifier ?? null,
    companyName: overrides.companyName ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    deletedAt: overrides.deletedAt ?? null,
  };
}

/**
 * Minimal `OrderService` fake. Only the methods the listeners call are
 * implemented; the rest throw so an accidental code path picks the throw
 * up loud.
 */
function makeOrderServiceFake(orders: Order[]): OrderService {
  const byId = new Map<string, Order>(orders.map((o) => [o.id, o]));
  const stub = (name: string) => () => {
    throw new Error(`OrderService.${name} not implemented in listener fake`);
  };
  return {
    getOrderById: async (id: string) => byId.get(id) ?? null,
    getOrderByNumber: stub("getOrderByNumber"),
    getOrderByCheckoutId: stub("getOrderByCheckoutId"),
    listOrders: stub("listOrders"),
    listCustomerOrders: stub("listCustomerOrders"),
    createFromIntent: stub("createFromIntent"),
    transitionStatus: stub("transitionStatus"),
    cancelOrder: stub("cancelOrder"),
    listStatusHistory: stub("listStatusHistory"),
  } as unknown as OrderService;
}

function makeCustomerServiceFake(customers: Customer[]): CustomerService {
  const byId = new Map<string, Customer>(customers.map((c) => [c.id, c]));
  const stub = (name: string) => () => {
    throw new Error(`CustomerService.${name} not implemented in listener fake`);
  };
  return {
    getCustomerById: async (id: string) => byId.get(id) ?? null,
    getCustomerByAuthUserId: stub("getCustomerByAuthUserId"),
    getCustomerByEmail: stub("getCustomerByEmail"),
    listCustomers: stub("listCustomers"),
    createCustomer: stub("createCustomer"),
    updateCustomer: stub("updateCustomer"),
    softDeleteCustomer: stub("softDeleteCustomer"),
    getAddressById: stub("getAddressById"),
    listAddresses: async (_id: string): Promise<CustomerAddress[]> => [],
    createAddress: stub("createAddress"),
    updateAddress: stub("updateAddress"),
    deleteAddress: stub("deleteAddress"),
    setDefaultAddress: stub("setDefaultAddress"),
    listProvinsi: stub("listProvinsi"),
    listKotaKabupaten: stub("listKotaKabupaten"),
    listKecamatan: stub("listKecamatan"),
    listKelurahan: stub("listKelurahan"),
    searchPostalCode: stub("searchPostalCode"),
  } as unknown as CustomerService;
}

interface ListenerWiring {
  service: NotificationServiceImpl;
  store: FakeStore;
  emailChannel: CapturingChannel;
  whatsappChannel?: CapturingChannel | NotificationChannel;
}

function buildWiring(opts: {
  orders?: Order[];
  customers?: Customer[];
  emailChannel?: NotificationChannel;
  whatsappChannel?: NotificationChannel;
} = {}): ListenerWiring {
  const store = createStore();
  const repo = createFakeRepo(store);
  const emailCh = (opts.emailChannel ?? createCapturingChannel("email")) as CapturingChannel;
  const channels = new Map<NotificationChannelId, NotificationChannel>();
  channels.set("email", emailCh);
  if (opts.whatsappChannel) channels.set("whatsapp", opts.whatsappChannel);

  const service = new NotificationServiceImpl({
    repository: repo,
    channels,
    orderService: makeOrderServiceFake(opts.orders ?? [makeOrder()]),
    customerService: makeCustomerServiceFake(opts.customers ?? [makeCustomer()]),
  });
  service.subscribeToEvents();
  return {
    service,
    store,
    emailChannel: emailCh,
    ...(opts.whatsappChannel ? { whatsappChannel: opts.whatsappChannel } : {}),
  };
}

// Each event bus is a module-level singleton — wipe its listener set
// before AND after each test so we (a) start clean and (b) leave nothing
// behind for unrelated tests in the same file (or the wider suite).
beforeEach(() => {
  orderEvents.clear();
  paymentEvents.clear();
  fulfillmentEvents.clear();
});
afterEach(() => {
  orderEvents.clear();
  paymentEvents.clear();
  fulfillmentEvents.clear();
});

// ---------------------------------------------------------------------------
// order.placed
// ---------------------------------------------------------------------------

describe("order.placed → order_confirmation", () => {
  it("renders the confirmation, dispatches via email, and persists a sent audit row", async () => {
    const order = makeOrder();
    const customer = makeCustomer();
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    expect(wiring.emailChannel.calls).toHaveLength(1);
    const [call] = wiring.emailChannel.calls;
    expect(call?.subject).toBe(
      `Pesanan Anda telah diterima — #${order.orderNumber}`,
    );
    expect(call?.body).toContain("Kemeja Putih");
    expect(call?.body).toContain(order.orderNumber);
    expect(call?.body).toContain("Rp 500.000"); // subtotal in id locale

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("sent");
    expect(row?.kind).toBe("order_confirmation");
    expect(row?.channel).toBe("email");
    expect(row?.eventId).toBe(`event:order.placed:${order.id}`);
  });

  it("uses the English template when the customer's locale is en", async () => {
    const order = makeOrder();
    // Stand in the locale field a future column adds. The service's
    // locale resolver reads `(customer as { locale?: string }).locale`
    // defensively, so injecting it on the fake exercises the en branch.
    const customer = Object.assign(makeCustomer(), { locale: "en" });
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    expect(wiring.emailChannel.calls[0]?.subject).toBe(
      `Your order has been received — #${order.orderNumber}`,
    );
    expect(wiring.emailChannel.calls[0]?.body).toContain(
      "Thank you. We have received your order.",
    );
  });

  it("uses guest contact info when the order has no customerId", async () => {
    const order = makeOrder({ customerId: null, email: "guest@example.com" });
    const wiring = buildWiring({ orders: [order], customers: [] });

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: null,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    expect(wiring.emailChannel.calls).toHaveLength(1);
    expect(wiring.emailChannel.calls[0]?.recipient).toBe("guest@example.com");
    // Default locale fallback: id (no customer record to read locale from).
    expect(wiring.emailChannel.calls[0]?.subject).toContain("Pesanan Anda");
  });

  it("is idempotent against duplicate event delivery — second emit is a no-op", async () => {
    const order = makeOrder();
    const customer = makeCustomer();
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    const eventPayload = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    };
    await orderEvents.emit("order.placed", eventPayload);
    await orderEvents.emit("order.placed", eventPayload);

    // Channel saw exactly one dispatch; second emit was suppressed by the
    // (event_id, kind, channel) unique index → service returned the existing row.
    expect(wiring.emailChannel.calls).toHaveLength(1);
    expect(wiring.store.rows.size).toBe(1);
  });

  it("does not crash the emit loop when the channel throws — failed audit row written", async () => {
    const throwing = createThrowingChannel("email", "smtp connection refused");
    const wiring = buildWiring({ emailChannel: throwing });

    // Should not reject — the listener handler swallows and logs.
    await expect(
      orderEvents.emit("order.placed", {
        orderId: "ord_test_1",
        orderNumber: "ORD-2026-000001",
        customerId: "cust_a",
        email: "buyer@example.com",
        totalAmount: "565000",
        currency: "IDR",
      }),
    ).resolves.toBeUndefined();

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("smtp connection refused");
  });

  it("skips WhatsApp when the registered channel is the v0.1 stub (default)", async () => {
    // No whatsapp channel registered → hasNonStubWhatsappChannel() returns
    // false → no WhatsApp dispatch attempt. Only one audit row (the email).
    const order = makeOrder();
    const wiring = buildWiring({ orders: [order] });

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    expect(wiring.store.rows.size).toBe(1);
    expect(Array.from(wiring.store.rows.values())[0]?.channel).toBe("email");
  });

  it("dispatches WhatsApp best-effort when a non-stub channel is registered and the customer has a phone", async () => {
    const order = makeOrder();
    const customer = makeCustomer({ phone: "+6281299990000" });
    const whatsappCh = createCapturingChannel("whatsapp");
    const wiring = buildWiring({
      orders: [order],
      customers: [customer],
      whatsappChannel: whatsappCh,
    });

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    // Email + WhatsApp = two channel dispatches and two audit rows.
    expect(wiring.emailChannel.calls).toHaveLength(1);
    expect(whatsappCh.calls).toHaveLength(1);
    expect(whatsappCh.calls[0]?.recipient).toBe("+6281299990000");
    expect(wiring.store.rows.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// payment.captured
// ---------------------------------------------------------------------------

describe("payment.captured → payment_received", () => {
  const captureEvent = (orderId: string, paymentId: string) => ({
    paymentId,
    orderId,
    provider: "in_memory_test",
  });

  it("looks up the order, renders payment_received, and dispatches via email", async () => {
    const order = makeOrder();
    const customer = makeCustomer();
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    await paymentEvents.emit(
      "payment.captured",
      captureEvent(order.id, "pay_1"),
    );

    expect(wiring.emailChannel.calls).toHaveLength(1);
    const [call] = wiring.emailChannel.calls;
    expect(call?.subject).toBe(`Pembayaran diterima — #${order.orderNumber}`);
    expect(call?.body).toContain("manual_bank_transfer"); // paymentMethod from order
    expect(call?.body).toContain("Rp 565.000"); // total amount

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("sent");
    expect(row?.kind).toBe("payment_received");
    expect(row?.eventId).toBe("event:payment.captured:pay_1");
  });

  it("uses the English template when the customer's locale is en", async () => {
    const order = makeOrder();
    const customer = Object.assign(makeCustomer(), { locale: "en" });
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    await paymentEvents.emit(
      "payment.captured",
      captureEvent(order.id, "pay_1"),
    );

    expect(wiring.emailChannel.calls[0]?.subject).toBe(
      `Payment received — #${order.orderNumber}`,
    );
    expect(wiring.emailChannel.calls[0]?.body).toContain(
      "We have received your payment.",
    );
  });

  it("is idempotent against duplicate event delivery", async () => {
    const order = makeOrder();
    const wiring = buildWiring({ orders: [order] });

    await paymentEvents.emit(
      "payment.captured",
      captureEvent(order.id, "pay_1"),
    );
    await paymentEvents.emit(
      "payment.captured",
      captureEvent(order.id, "pay_1"),
    );

    expect(wiring.emailChannel.calls).toHaveLength(1);
    expect(wiring.store.rows.size).toBe(1);
  });

  it("records a failed audit row when the channel throws and does not crash the emit loop", async () => {
    const throwing = createThrowingChannel("email", "boom");
    const wiring = buildWiring({ emailChannel: throwing });

    await expect(
      paymentEvents.emit("payment.captured", captureEvent("ord_test_1", "pay_1")),
    ).resolves.toBeUndefined();

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// fulfillment.shipped
// ---------------------------------------------------------------------------

describe("fulfillment.shipped → shipping_update", () => {
  const shippedEvent = (
    orderId: string,
    fulfillmentId: string,
    trackingCode: string | null,
  ) => ({
    fulfillmentId,
    orderId,
    trackingCode,
    actorKind: "staff" as const,
  });

  it("renders the shipping update with the tracking code and dispatches via email", async () => {
    const order = makeOrder();
    const customer = makeCustomer();
    const wiring = buildWiring({ orders: [order], customers: [customer] });

    await fulfillmentEvents.emit(
      "fulfillment.shipped",
      shippedEvent(order.id, "ful_1", "JNE12345"),
    );

    expect(wiring.emailChannel.calls).toHaveLength(1);
    const [call] = wiring.emailChannel.calls;
    expect(call?.subject).toBe(`Pembaruan pengiriman — #${order.orderNumber}`);
    expect(call?.body).toContain("Resi: JNE12345");

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("sent");
    expect(row?.kind).toBe("shipping_update");
    expect(row?.eventId).toBe("event:fulfillment.shipped:ful_1");
  });

  it("omits the tracking line when the courier code is null", async () => {
    const order = makeOrder();
    const wiring = buildWiring({ orders: [order] });

    await fulfillmentEvents.emit(
      "fulfillment.shipped",
      shippedEvent(order.id, "ful_2", null),
    );

    expect(wiring.emailChannel.calls[0]?.body).not.toContain("Resi:");
  });

  it("is idempotent against duplicate event delivery", async () => {
    const order = makeOrder();
    const wiring = buildWiring({ orders: [order] });

    await fulfillmentEvents.emit(
      "fulfillment.shipped",
      shippedEvent(order.id, "ful_1", "JNE12345"),
    );
    await fulfillmentEvents.emit(
      "fulfillment.shipped",
      shippedEvent(order.id, "ful_1", "JNE12345"),
    );

    expect(wiring.emailChannel.calls).toHaveLength(1);
    expect(wiring.store.rows.size).toBe(1);
  });

  it("records a failed audit row when the channel throws and does not crash the emit loop", async () => {
    const throwing = createThrowingChannel("email", "courier-template-rejected");
    const wiring = buildWiring({ emailChannel: throwing });

    await expect(
      fulfillmentEvents.emit(
        "fulfillment.shipped",
        shippedEvent("ord_test_1", "ful_1", "JNE12345"),
      ),
    ).resolves.toBeUndefined();

    expect(wiring.store.rows.size).toBe(1);
    const [row] = Array.from(wiring.store.rows.values());
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("courier-template-rejected");
  });
});

// ---------------------------------------------------------------------------
// subscribeToEvents idempotency
// ---------------------------------------------------------------------------

describe("subscribeToEvents", () => {
  it("is a no-op past the first call (no double-dispatch on a single event)", async () => {
    const order = makeOrder();
    const wiring = buildWiring({ orders: [order] });
    // buildWiring already called subscribeToEvents() once; call again
    // and assert the listener does not double-fire.
    wiring.service.subscribeToEvents();

    await orderEvents.emit("order.placed", {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      email: order.email,
      totalAmount: order.total.amount.toString(),
      currency: order.currency,
    });

    expect(wiring.emailChannel.calls).toHaveLength(1);
  });
});

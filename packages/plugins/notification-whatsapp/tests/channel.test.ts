import { describe, expect, it } from "vitest";
import type { PluginLogger } from "@mt-commerce/core/plugin";
import { WhatsappBusinessChannel } from "../src/channel.js";
import { ChannelDispatchError, UnsupportedKindError } from "../src/errors.js";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

function makeLogger(): PluginLogger {
  const noop = (..._args: unknown[]) => {
    void _args;
  };
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as PluginLogger;
}

function makeFetch(
  responder: (call: FetchCall) => Response,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  // The fake only implements the call signature — `typeof fetch` under
  // Bun also requires a `preconnect` property which the channel never
  // touches, so we cast through `unknown` to keep the test focused on
  // the wire shape.
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let body: unknown = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      /* keep raw */
    }
    const call: FetchCall = { url, init, body };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const baseOptions = {
  phoneNumberId: "111222333",
  accessToken: "EAAG-TEST-TOKEN",
  templates: {
    order_confirmation: "order_confirmation_id",
    payment_received: "payment_received_id",
    shipping_update: "shipping_update_id",
  },
  graphBaseUrl: "https://graph.test/v20.0",
};

describe("WhatsappBusinessChannel", () => {
  it("rejects construction without required options", () => {
    expect(
      () =>
        new WhatsappBusinessChannel(
          { ...baseOptions, phoneNumberId: "" },
          makeLogger(),
        ),
    ).toThrow(/phoneNumberId/);
    expect(
      () =>
        new WhatsappBusinessChannel(
          { ...baseOptions, accessToken: "" },
          makeLogger(),
        ),
    ).toThrow(/accessToken/);
    expect(
      () =>
        new WhatsappBusinessChannel(
          {
            ...baseOptions,
            templates: {
              order_confirmation: "x",
              payment_received: "",
              shipping_update: "z",
            },
          },
          makeLogger(),
        ),
    ).toThrow(/templates/);
  });

  it("posts a templated WhatsApp message with the expected wire shape", async () => {
    const { fetchImpl, calls } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            contacts: [{ wa_id: "628123456789" }],
            messages: [{ id: "wamid.HBg..." }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const channel = new WhatsappBusinessChannel(
      { ...baseOptions, fetch: fetchImpl },
      makeLogger(),
    );

    await channel.send({
      recipient: "08123456789",
      kind: "order_confirmation",
      body: "(rendered body — channel ignores)",
      payload: {
        orderId: "MT-2025-000123",
        items: [
          { name: "Kemeja", quantity: 1, unitPrice: { amount: "250000", currency: "IDR" } },
        ],
        totals: {
          subtotal: { amount: "250000", currency: "IDR" },
          tax: { amount: "0", currency: "IDR" },
          shipping: { amount: "20000", currency: "IDR" },
          total: { amount: "270000", currency: "IDR" },
        },
      },
      locale: "id",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://graph.test/v20.0/111222333/messages");
    expect(call.init?.method).toBe("POST");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer EAAG-TEST-TOKEN",
    );
    expect(call.body).toEqual({
      messaging_product: "whatsapp",
      to: "628123456789",
      type: "template",
      template: {
        name: "order_confirmation_id",
        language: { code: "id" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "MT-2025-000123" },
              { type: "text", text: "Rp 270.000" },
              { type: "text", text: "1 barang" },
            ],
          },
        ],
      },
    });
  });

  it("uses the configured default language when the platform does not pass a locale", async () => {
    const { fetchImpl, calls } = makeFetch(
      () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const channel = new WhatsappBusinessChannel(
      { ...baseOptions, language: "en", fetch: fetchImpl },
      makeLogger(),
    );

    await channel.send({
      recipient: "+628123456789",
      kind: "payment_received",
      body: "ignored",
      payload: {
        orderId: "MT-2025-000123",
        amount: { amount: "270000", currency: "IDR" },
        paymentMethod: "manual_transfer",
      },
    });

    const body = calls[0]!.body as { template: { language: { code: string } } };
    expect(body.template.language.code).toBe("en");
  });

  it("throws UnsupportedKindError when the kind has no template configured", async () => {
    const { fetchImpl, calls } = makeFetch(
      () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const channel = new WhatsappBusinessChannel(
      { ...baseOptions, fetch: fetchImpl },
      makeLogger(),
    );

    await expect(
      channel.send({
        recipient: "08123456789",
        kind: "email_verification",
        body: "ignored",
        payload: { url: "https://example/verify" },
      }),
    ).rejects.toBeInstanceOf(UnsupportedKindError);

    expect(calls).toHaveLength(0);
  });

  it("surfaces a 400 from Meta as a ChannelDispatchError with the parsed envelope", async () => {
    const errorBody = {
      error: {
        message: "Template name does not exist in the translation",
        type: "OAuthException",
        code: 132001,
        error_subcode: 2494010,
        fbtrace_id: "trace-abc",
      },
    };
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify(errorBody), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    const channel = new WhatsappBusinessChannel(
      { ...baseOptions, fetch: fetchImpl },
      makeLogger(),
    );

    let caught: unknown;
    try {
      await channel.send({
        recipient: "08123456789",
        kind: "shipping_update",
        body: "ignored",
        payload: {
          orderId: "MT-2025-000123",
          trackingCode: "JX-1",
          status: "shipped",
        },
        locale: "id",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChannelDispatchError);
    const dispatchErr = caught as ChannelDispatchError;
    expect(dispatchErr.status).toBe(400);
    expect(dispatchErr.details).toEqual(errorBody);
    expect(dispatchErr.message).toMatch(/Template name does not exist/);
    expect(dispatchErr.message).toMatch(/code=132001/);
  });

  it("throws when the kind is one we support but the structured payload is missing", async () => {
    const { fetchImpl, calls } = makeFetch(
      () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const channel = new WhatsappBusinessChannel(
      { ...baseOptions, fetch: fetchImpl },
      makeLogger(),
    );

    await expect(
      channel.send({
        recipient: "08123456789",
        kind: "order_confirmation",
        body: "ignored",
        // payload deliberately omitted
      }),
    ).rejects.toThrow(/missing structured payload/);

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real Meta API tests — gated by env vars, skipped by default. Wire them
// once the operator has registered the templates and copied a permanent
// access token. See the README for the bootstrap procedure.
// ---------------------------------------------------------------------------

const REAL_PHONE = process.env["WHATSAPP_PHONE_NUMBER_ID"];
const REAL_TOKEN = process.env["WHATSAPP_ACCESS_TOKEN"];
const REAL_RECIPIENT = process.env["WHATSAPP_TEST_RECIPIENT"];
const realApiSuite = REAL_PHONE && REAL_TOKEN && REAL_RECIPIENT ? describe : describe.skip;

realApiSuite("WhatsappBusinessChannel (live Meta API)", () => {
  it("sends a templated order confirmation to the configured test recipient", async () => {
    const channel = new WhatsappBusinessChannel(
      {
        phoneNumberId: REAL_PHONE!,
        accessToken: REAL_TOKEN!,
        templates: {
          order_confirmation:
            process.env["WHATSAPP_TEMPLATE_ORDER_CONFIRMATION"] ?? "order_confirmation_id",
          payment_received:
            process.env["WHATSAPP_TEMPLATE_PAYMENT_RECEIVED"] ?? "payment_received_id",
          shipping_update:
            process.env["WHATSAPP_TEMPLATE_SHIPPING_UPDATE"] ?? "shipping_update_id",
        },
      },
      makeLogger(),
    );

    await channel.send({
      recipient: REAL_RECIPIENT!,
      kind: "order_confirmation",
      body: "ignored",
      locale: "id",
      payload: {
        orderId: "MT-LIVE-TEST",
        items: [
          {
            name: "Kemeja",
            quantity: 1,
            unitPrice: { amount: "250000", currency: "IDR" },
          },
        ],
        totals: {
          subtotal: { amount: "250000", currency: "IDR" },
          tax: { amount: "0", currency: "IDR" },
          shipping: { amount: "20000", currency: "IDR" },
          total: { amount: "270000", currency: "IDR" },
        },
      },
    });
  });
});

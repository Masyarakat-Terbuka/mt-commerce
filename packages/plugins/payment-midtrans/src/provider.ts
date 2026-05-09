/**
 * `MidtransPaymentProvider` — the `PaymentProvider` mt-commerce loads when
 * the `@mt-commerce/plugin-payment-midtrans` plugin is registered.
 *
 * Lifecycle:
 *
 *   1. `initiate(intent)` — POST `/snap/v1/transactions`. Returns
 *      `{ redirectUrl, providerTransactionId: snapToken }`. The buyer
 *      bounces through Snap's hosted page; on completion they return to
 *      `finishUrl` and Midtrans posts a webhook to the platform.
 *
 *   2. `capture(intent)` — Snap captures synchronously for QRIS / VA /
 *      GoPay / etc. Card pre-authorisation is out of scope for v0.1, so
 *      this method is a no-op that records `amountCaptured = intent.amount`.
 *      The platform's payments service still records an attempt row for
 *      audit parity.
 *
 *   3. `refund(intent, amount?)` — POST `/v2/{paymentId}/refund` against
 *      the Midtrans Core API. `refund_key` is set to the platform's
 *      `idempotencyKey` so a retry is a no-op on Midtrans's side.
 *
 *   4. `verifyWebhookSignature({ rawBody, headers })` — parse the JSON
 *      body, recompute SHA512(order_id + status_code + gross_amount +
 *      serverKey), compare in constant time. Returns `true | false` per
 *      the core interface; the platform translates `false` to a 401
 *      response.
 *
 * Mapping the Midtrans `transaction_status` onto the platform's
 * (`captured | failed | refunded`) lifecycle is exposed as a separate
 * pure helper (`mapMidtransStatus` in `templates.ts`) so the API's
 * webhook dispatcher can reuse it after this provider returns `true`.
 */
import type {
  PaymentCaptureResult,
  PaymentInitiateResult,
  PaymentIntentLike,
  PaymentProvider,
  PaymentRefundResult,
  PaymentStatusSnapshot,
  PluginLogger,
} from "@mt-commerce/core/plugin";
import type { Money } from "@mt-commerce/core/money";
import { id } from "@mt-commerce/core/ulid";
import { verifyMidtransSignature } from "./signature.js";
import {
  SnapClient,
  TRANSACTION_NOT_FOUND,
  type FetchLike,
  type MidtransMode,
} from "./snap.js";
import { buildSnapTransactionRequest, mapMidtransStatus } from "./templates.js";

/** Stable provider code stored on the platform's `payments.provider` column. */
export const MIDTRANS_PROVIDER_CODE = "midtrans";

/**
 * Constructor options. Mirrors `MidtransOptions` in `index.ts` plus the
 * test-only `fetchImpl` seam (the public factory does NOT expose
 * `fetchImpl` to operators — it is for tests and advanced wiring).
 */
export interface MidtransProviderOptions {
  readonly serverKey: string;
  readonly clientKey: string;
  readonly mode?: MidtransMode;
  readonly finishUrl?: string;
  readonly errorUrl?: string;
  readonly pendingUrl?: string;
  /** Test seam — defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

export class MidtransPaymentProvider implements PaymentProvider {
  readonly code = MIDTRANS_PROVIDER_CODE;
  readonly displayName = "Midtrans";

  private readonly client: SnapClient;
  private readonly serverKey: string;
  private readonly callbacks: {
    finish?: string;
    error?: string;
    pending?: string;
  };
  private readonly log: PluginLogger | undefined;

  constructor(options: MidtransProviderOptions, log?: PluginLogger) {
    if (!options.serverKey || options.serverKey.trim() === "") {
      throw new Error(
        "MidtransPaymentProvider: serverKey is required (set MIDTRANS_SERVER_KEY)",
      );
    }
    if (!options.clientKey || options.clientKey.trim() === "") {
      // The clientKey is not used server-side, but we validate at
      // construction so an operator's misconfiguration surfaces at
      // boot rather than mysteriously at storefront load.
      throw new Error(
        "MidtransPaymentProvider: clientKey is required (the storefront uses it for snap.js)",
      );
    }
    this.serverKey = options.serverKey;
    this.client = new SnapClient({
      serverKey: options.serverKey,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.fetchImpl !== undefined
        ? { fetchImpl: options.fetchImpl }
        : {}),
    });
    this.callbacks = {
      ...(options.finishUrl !== undefined ? { finish: options.finishUrl } : {}),
      ...(options.errorUrl !== undefined ? { error: options.errorUrl } : {}),
      ...(options.pendingUrl !== undefined
        ? { pending: options.pendingUrl }
        : {}),
    };
    this.log = log;
  }

  // -------------------------------------------------------------------
  // PaymentProvider
  // -------------------------------------------------------------------

  async initiate(intent: PaymentIntentLike): Promise<PaymentInitiateResult> {
    const customer = readCustomer(intent.metadata);
    const customFields = readCustomFields(intent);

    const body = buildSnapTransactionRequest({
      paymentId: intent.id,
      amount: intent.amount,
      ...(customer ? { customer } : {}),
      ...(this.hasAnyCallback() ? { callbacks: this.callbacks } : {}),
      ...(customFields ? { customFields } : {}),
    });

    this.log?.debug(
      { paymentId: intent.id, currency: intent.amount.currency },
      "midtrans: requesting Snap transaction token",
    );

    const snap = await this.client.createTransaction(
      body as unknown as Record<string, unknown>,
    );

    return {
      providerTransactionId: snap.token,
      redirectUrl: snap.redirect_url,
      raw: snap as unknown as Record<string, unknown>,
    };
  }

  /**
   * Snap captures synchronously for the channels we enable (QRIS, VA,
   * GoPay, ShopeePay, Indomaret/Alfamart). Cards in pre-authorise mode
   * (`pre_authorize: true` on the Snap request) DO require an explicit
   * capture call, but v0.1 only ships immediate capture — so `capture`
   * here is a structured no-op that the payments service can record.
   */
  capture(intent: PaymentIntentLike): Promise<PaymentCaptureResult> {
    return Promise.resolve({
      providerTransactionId: intent.id,
      amountCaptured: intent.amount,
      raw: { note: "midtrans: capture is a no-op for Snap auto-capture flows" },
    });
  }

  async refund(
    intent: PaymentIntentLike,
    amount?: Money,
  ): Promise<PaymentRefundResult> {
    const refundAmount = amount ?? intent.amount;
    // Use the platform-supplied idempotency key as Midtrans's refund_key
    // when present — otherwise mint a fresh ULID. Reusing the platform's
    // key keeps the two systems' idempotency aligned: a retry of the
    // same refund call will not double-refund on Midtrans's side.
    const refundKey = intent.idempotencyKey || id("rfd");
    const grossAmount = moneyToMajorUnit(refundAmount);

    this.log?.debug(
      {
        paymentId: intent.id,
        refundKey,
        amount: grossAmount,
        currency: refundAmount.currency,
      },
      "midtrans: requesting refund",
    );

    const response = await this.client.refund({
      orderId: intent.id,
      refundKey,
      amount: grossAmount,
      ...(typeof intent.metadata?.["refundReason"] === "string"
        ? { reason: intent.metadata["refundReason"] }
        : {}),
    });

    return {
      providerTransactionId: response.transaction_id ?? intent.id,
      amountRefunded: refundAmount,
      raw: response as unknown as Record<string, unknown>,
    };
  }

  /**
   * Per the core interface, returns `boolean`. The platform's webhook
   * route translates `false` to a 401 without dispatching the payload.
   *
   * The body is parsed leniently — a malformed body short-circuits to
   * `false` rather than throwing, so a hostile sender cannot crash the
   * webhook handler with an empty request.
   */
  verifyWebhookSignature(input: {
    rawBody: string;
    headers: Record<string, string>;
  }): boolean {
    void input.headers; // Midtrans carries the signature in the body, not a header
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      return false;
    }
    return verifyMidtransSignature(
      {
        order_id:
          typeof payload.order_id === "string" ? payload.order_id : undefined,
        status_code:
          typeof payload.status_code === "string"
            ? payload.status_code
            : undefined,
        gross_amount:
          typeof payload.gross_amount === "string"
            ? payload.gross_amount
            : undefined,
        signature_key:
          typeof payload.signature_key === "string"
            ? payload.signature_key
            : undefined,
      },
      this.serverKey,
    );
  }

  /**
   * Reconciliation entry point. Asks Midtrans for the current state of
   * the transaction whose `order_id` equals the platform's `intent.id`
   * (the plugin sets the two equal at `initiate` time, so this lookup
   * is symmetric with the refund flow).
   *
   * `mapMidtransStatus` projects Midtrans's `transaction_status` +
   * optional `fraud_status` onto the platform enum. The
   * `"ignore"` outcome (Midtrans `pending` / `authorize` / `capture`
   * with `fraud_status === "challenge"`) is surfaced as `"pending"` —
   * the platform's reconciler treats it as "no transition yet" and
   * leaves the row alone.
   */
  async fetchStatus(
    intent: PaymentIntentLike,
  ): Promise<PaymentStatusSnapshot | null> {
    this.log?.debug(
      { paymentId: intent.id },
      "midtrans: querying transaction status",
    );

    const response = await this.client.getTransactionStatus(intent.id);
    if (response === TRANSACTION_NOT_FOUND) {
      this.log?.info(
        { paymentId: intent.id },
        "midtrans: transaction not found (likely never settled)",
      );
      return null;
    }

    const mapped = mapMidtransStatus(
      response.transaction_status,
      response.fraud_status,
    );
    const status: PaymentStatusSnapshot["status"] =
      mapped === "ignore" ? "pending" : mapped;

    return {
      providerRef: response.transaction_id,
      status,
      raw: response as unknown as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private hasAnyCallback(): boolean {
    return Boolean(
      this.callbacks.finish || this.callbacks.error || this.callbacks.pending,
    );
  }
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Read customer descriptor from the intent's metadata. The payments
 * service stages the customer block under `metadata.customer` when
 * routing to a plugin provider — see the `InitiateInput` shape on the
 * API side. The plugin tolerates missing fields.
 */
function readCustomer(
  metadata: Record<string, string> | undefined,
): { name?: string; email?: string; phone?: string } | undefined {
  if (!metadata) return undefined;
  const out: { name?: string; email?: string; phone?: string } = {};
  const fromTopLevel = (
    key: "customerName" | "customerEmail" | "customerPhone",
  ) => (typeof metadata[key] === "string" ? metadata[key] : undefined);

  const name = fromTopLevel("customerName");
  const email = fromTopLevel("customerEmail");
  const phone = fromTopLevel("customerPhone");
  if (name) out.name = name;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCustomFields(intent: PaymentIntentLike):
  | {
      customField1?: string;
      customField2?: string;
      customField3?: string;
    }
  | undefined {
  const fields: {
    customField1?: string;
    customField2?: string;
    customField3?: string;
  } = {};
  // Always stash the platform's intent id in custom_field1 — useful for
  // ops to cross-reference a Snap dashboard transaction with our row.
  fields.customField1 = intent.id;
  if (intent.orderId) fields.customField2 = intent.orderId;
  return fields;
}

function moneyToMajorUnit(money: Money): number {
  if (money.currency === "IDR") {
    return Number(money.amount);
  }
  return Math.round(Number(money.amount) / 100);
}

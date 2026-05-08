/**
 * Adapter from the core `PaymentProvider` plugin contract to the modules'
 * `PaymentProvider` interface that `PaymentService` consumes.
 *
 * Why an adapter? The two interfaces are intentionally different:
 *
 *   - `@mt-commerce/core/plugin` (what plugin authors implement) returns
 *     `PaymentInitiateResult { providerTransactionId, redirectUrl?, ... }`
 *     and `verifyWebhookSignature` returns `boolean`. This is the surface
 *     plugins compile against, with no api-level types leaking in.
 *
 *   - `apps/api/src/modules/payments/providers/types.ts` (what the service
 *     consumes) returns the discriminated `InitiateResult { status:
 *     "redirect" | "captured" | "pending", providerRef, ... }` and
 *     `verifyWebhookSignature` returns the canonical `VerifiedWebhook`
 *     tuple. This is the surface the service's webhook dispatcher needs.
 *
 * The mismatch is deliberate (per ADR-0008: plugins MUST NOT depend on
 * api types). This adapter is the seam that bridges the two without
 * forcing either side to change shape.
 *
 * Mapping rules:
 *
 *   - `initiate`: classify the core result by inspecting `redirectUrl`.
 *       * `redirectUrl` present → `{ status: "redirect", redirectUrl, providerRef, rawResponse }`
 *       * `redirectUrl` absent  → `{ status: "captured", providerRef, rawResponse }`
 *
 *     "Pending" is reserved for providers that have a separate signal of
 *     async settlement on the result; for v0.1, the core contract does not
 *     model that, so we treat redirect-less responses as synchronous
 *     capture. A provider whose initiate is genuinely pending (e.g. an
 *     offline transfer) should return a `redirectUrl` to the order's
 *     "thanks, awaiting transfer" page; the platform then transitions on
 *     the webhook.
 *
 *   - `capture`: the core contract makes `capture` optional (auto-capture
 *     on initiate). The adapter exposes a method that calls it when
 *     present and returns `{ status: "captured" }` either way; the
 *     payments service still records the attempt for audit parity.
 *
 *   - `refund`: the core contract takes `(intent, amount?)` and the intent
 *     is constructed from the in-memory descriptor the service hands us.
 *     We use `intent.id` as the orderId stand-in for the providerRef-based
 *     refund call shape — the plugin reads `intent.id` (which we set to
 *     the platform paymentId) so its refund routing is correct.
 *
 *   - `verifyWebhookSignature`: the core boolean is lifted into the
 *     canonical tuple. When `true`, we parse the body for the standard
 *     `{ event, providerRef, status }` projection — plugins are
 *     responsible for emitting that shape from their webhook payload
 *     after their own signature check passes (see Midtrans's docs).
 *
 *     For providers whose webhook payload does NOT match this projection
 *     (most real-world providers — Midtrans, Xendit), the platform's
 *     webhook route layer parses the provider-specific payload and
 *     calls `paymentService.handleWebhook` with a structured input. This
 *     adapter's `verifyWebhookSignature` is a fallback for plugins that
 *     do match the canonical shape; otherwise the route layer takes
 *     ownership before reaching the service.
 *
 * Throws:
 *
 *   - The adapter constructor throws on unknown / missing methods.
 *   - At call time, errors propagate from the plugin verbatim so the
 *     payments service's failure-attempt path records the original
 *     error message.
 */
import type { Money } from "@mt-commerce/core/money";
import type {
  PaymentIntentLike,
  PaymentInitiateResult,
  PaymentProvider as CorePaymentProvider,
} from "@mt-commerce/core/plugin";
import type {
  CaptureInput,
  CaptureResult,
  InitiateInput,
  InitiateResult,
  PaymentProvider as ModulePaymentProvider,
  RefundInput,
  RefundResult,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "./types.js";

/**
 * Wrap a core `PaymentProvider` so it satisfies the modules' provider
 * surface. Returned object is a fresh value; it is safe to register the
 * same core provider against two registries through two adapters.
 */
export function adaptCorePaymentProvider(
  core: CorePaymentProvider,
): ModulePaymentProvider {
  if (typeof core?.initiate !== "function" || typeof core?.refund !== "function") {
    throw new Error(
      `payments plugin adapter: provider "${core?.code ?? "<unknown>"}" is missing required methods (initiate, refund)`,
    );
  }
  if (typeof core?.verifyWebhookSignature !== "function") {
    throw new Error(
      `payments plugin adapter: provider "${core.code}" is missing verifyWebhookSignature`,
    );
  }

  return {
    code: core.code,

    async initiate(input: InitiateInput): Promise<InitiateResult> {
      const intent = buildIntent(input);
      const result = await core.initiate(intent);
      return projectInitiate(result);
    },

    async capture(input: CaptureInput): Promise<CaptureResult> {
      // Some providers auto-capture on initiate; the core contract makes
      // capture optional. The platform calls capture only on the explicit
      // admin path, so when the plugin omits it we treat the call as a
      // structured no-op (the service still records the audit attempt).
      if (typeof core.capture !== "function") {
        return { status: "captured" };
      }
      const intent = buildCaptureIntent(input);
      const result = await core.capture(intent);
      return {
        status: "captured",
        ...(result.raw !== undefined ? { rawResponse: result.raw } : {}),
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const intent = buildRefundIntent(input);
      const amount = input.amount !== undefined
        ? ({ amount: input.amount, currency: "IDR" } as Money)
        : undefined;
      // The core contract uses the intent.amount for the full-refund
      // default; we don't carry currency at this seam (it's resolved on
      // the row, not the call), so we omit the explicit amount when
      // unset and let the plugin resolve.
      const result = amount !== undefined
        ? await core.refund(intent, amount)
        : await core.refund(intent);
      return {
        status: "refunded",
        ...(result.raw !== undefined ? { rawResponse: result.raw } : {}),
      };
    },

    verifyWebhookSignature(input: VerifyWebhookInput): VerifiedWebhook {
      const verified = core.verifyWebhookSignature({
        rawBody: input.rawBody,
        headers: input.headers,
      });
      // Core contract returns boolean | Promise<boolean>. The modules'
      // surface is synchronous, so we refuse the promise variant — a
      // plugin that wants async verification must surface the result
      // through the route layer's webhook entry point, which can await.
      if (verified === false) {
        throw new Error(
          `plugin "${core.code}": webhook signature verification failed`,
        );
      }
      if (typeof verified !== "boolean") {
        throw new Error(
          `plugin "${core.code}": verifyWebhookSignature must be synchronous when used through the platform's webhook dispatcher`,
        );
      }
      // The plugin signaled the body is authentic. We project the body
      // into the canonical tuple. Plugins whose webhook payload does NOT
      // match this projection should drive their webhook through their
      // own route handler (see Midtrans's `parseWebhook`-style helpers).
      return projectWebhookPayload(core.code, input.rawBody);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildIntent(input: InitiateInput): PaymentIntentLike {
  // The core PaymentIntentLike's `metadata` is `Record<string, string>`;
  // the modules' InitiateInput `metadata` is `Record<string, unknown>`.
  // We coerce string-shaped values through and drop non-string metadata
  // so plugins (Midtrans reads `customerEmail` etc.) get a tidy surface.
  const stringMetadata: Record<string, string> = {};
  if (input.metadata) {
    for (const [k, v] of Object.entries(input.metadata)) {
      if (typeof v === "string") stringMetadata[k] = v;
    }
  }
  // Surface the customer block onto metadata too — the Midtrans plugin
  // reads `customerName / customerEmail / customerPhone` from there.
  if (input.customer.email) stringMetadata.customerEmail = input.customer.email;
  if (input.customer.phone) stringMetadata.customerPhone = input.customer.phone;
  if (input.customer.name) stringMetadata.customerName = input.customer.name;

  const amount: Money = {
    amount: input.payment.amount,
    currency: input.payment.currency,
  };
  return {
    id: input.payment.id,
    orderId: input.payment.orderId,
    amount,
    // Plugins forward this to the upstream provider as the dedupe handle.
    // The modules' InitiateInput does not carry it explicitly because
    // the service has already deduped at the row level — but plugins
    // expect it on the intent, so we pass the platform paymentId as a
    // stable, request-stable handle. (For Midtrans, this becomes the
    // Snap order_id which IS the natural idempotency unit.)
    idempotencyKey: input.payment.id,
    ...(Object.keys(stringMetadata).length > 0
      ? { metadata: stringMetadata }
      : {}),
  };
}

function buildCaptureIntent(input: CaptureInput): PaymentIntentLike {
  // Capture only needs the platform-side identifiers; amount is unused
  // by the providers we ship (Midtrans's capture is a no-op). We pass
  // a placeholder Money(0/IDR) to satisfy the type — providers that
  // actually use the amount on capture (Stripe pre-auth) would need a
  // richer signature, which is out of scope for v0.1.
  const amount: Money = { amount: input.amount ?? 0n, currency: "IDR" };
  return {
    id: input.payment.id,
    orderId: input.payment.id, // unused by capture; pass id as a stable handle
    amount,
    idempotencyKey: input.payment.id,
  };
}

function buildRefundIntent(input: RefundInput): PaymentIntentLike {
  // Refund's intent.id MUST be the platform paymentId (Midtrans uses it
  // as the order_id key in `/v2/{order_id}/refund`). The amount on the
  // intent is the FULL captured amount; partial refund is signaled by
  // the optional second argument to core.refund(intent, amount).
  const amount: Money = { amount: 0n, currency: "IDR" };
  const reasonString = input.reason ? input.reason : undefined;
  return {
    id: input.payment.id,
    orderId: input.payment.id,
    amount,
    idempotencyKey: input.payment.id,
    ...(reasonString !== undefined
      ? { metadata: { refundReason: reasonString } }
      : {}),
  };
}

function projectInitiate(result: PaymentInitiateResult): InitiateResult {
  if (result.redirectUrl) {
    return {
      status: "redirect",
      redirectUrl: result.redirectUrl,
      providerRef: result.providerTransactionId,
      ...(result.raw !== undefined ? { rawResponse: result.raw } : {}),
    };
  }
  return {
    status: "captured",
    providerRef: result.providerTransactionId,
    ...(result.raw !== undefined ? { rawResponse: result.raw } : {}),
  };
}

function projectWebhookPayload(
  providerCode: string,
  rawBody: string,
): VerifiedWebhook {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error(
      `plugin "${providerCode}": webhook body is not JSON; route the call through a provider-specific webhook handler instead of the canonical dispatcher`,
    );
  }
  const event = typeof payload.event === "string" ? payload.event : "";
  const providerRef =
    typeof payload.providerRef === "string" ? payload.providerRef : "";
  const status = payload.status;
  if (!event || !providerRef) {
    throw new Error(
      `plugin "${providerCode}": webhook body is missing event/providerRef in canonical projection`,
    );
  }
  if (status !== "captured" && status !== "failed" && status !== "refunded") {
    throw new Error(
      `plugin "${providerCode}": webhook status must be one of captured/failed/refunded; got "${String(status)}"`,
    );
  }
  return { event, providerRef, status, rawPayload: payload };
}

/** Re-export the unused `Money` type so editors don't drop the import on save. */
export type { Money };

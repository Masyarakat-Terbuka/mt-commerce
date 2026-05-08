/**
 * Webhook ingress for payment providers.
 *
 * Mounted at the top level: `POST /webhooks/payments/{providerCode}`.
 * No auth gate — the signature on the request body IS the auth. The
 * service hands the raw body + headers to the provider's
 * `verifyWebhookSignature(...)`; an unverified payload throws and
 * surfaces as a 400 (we do NOT 401, which would imply Better Auth or
 * an api-key check).
 *
 * Idempotency: handled inside the service. A second delivery of the
 * same `(providerRef, status)` writes a fresh attempt row but does not
 * re-transition. We do NOT mount the HTTP-layer
 * `requireIdempotencyKey` here because providers cannot promise to
 * supply an `Idempotency-Key` header; the dedupe lives at the data
 * layer instead.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  defaultValidationHook,
  errorResponse,
} from "../../../lib/openapi-shared.js";
import type { AppBindings } from "../../../lib/types.js";
import type { PaymentService } from "../service.js";
import { WebhookAckWire } from "./openapi-schemas.js";

const TAG = "payments (webhook)";

const ProviderParam = z.object({
  providerCode: z.string().min(1).max(64),
});

export function buildPaymentsWebhookRoutes(
  service: PaymentService,
): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: defaultValidationHook,
  });

  router.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/payments/{providerCode}",
      tags: [TAG],
      summary: "Provider webhook ingress (signature-verified)",
      description:
        "Generic webhook endpoint. Dispatches to the provider's `verifyWebhookSignature`. Returns `{ status: 'accepted' | 'ignored' }` — `ignored` covers unknown payment refs and idempotent re-deliveries.",
      request: { params: ProviderParam },
      responses: {
        200: {
          content: { "application/json": { schema: WebhookAckWire } },
          description: "Webhook processed.",
        },
        400: errorResponse("Signature verification failed or unknown provider."),
      },
    }),
    async (c) => {
      const providerCode = c.req.param("providerCode");
      // Read the raw body as text — signature schemes hash the bytes,
      // not the parsed JSON. Hono caches `text()` so the service can
      // re-derive the JSON shape itself without a second read.
      const rawBody = await c.req.text();

      // Lower-case every header so providers that capitalise their
      // signature header inconsistently (Stripe vs Midtrans) reach
      // the same lookup key inside the provider implementation.
      const headers: Record<string, string> = {};
      const headerObj = c.req.header();
      for (const [k, v] of Object.entries(headerObj)) {
        headers[k.toLowerCase()] = v;
      }

      const result = await service.handleWebhook({
        providerCode,
        rawBody,
        headers,
      });
      return c.json(result, 200);
    },
  );

  return router;
}

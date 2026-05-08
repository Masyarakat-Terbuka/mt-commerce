/**
 * Shared OpenAPI wire-shape schemas for the shipping admin fulfillment
 * routes. Registered once so the generated spec contains a single
 * `Fulfillment` component the SDK can mirror.
 */
import { z } from "@hono/zod-openapi";
import { listEnvelope } from "../../../lib/openapi-shared.js";

const FulfillmentStatusEnum = z.enum([
  "pending",
  "shipped",
  "delivered",
  "cancelled",
]);

export const FulfillmentWire = z
  .object({
    id: z.string(),
    orderId: z.string(),
    shippingMethodId: z.string(),
    status: FulfillmentStatusEnum,
    trackingCode: z.string().nullable(),
    trackedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Fulfillment");

export const FulfillmentListEnvelope = listEnvelope(FulfillmentWire).openapi(
  "FulfillmentList",
);

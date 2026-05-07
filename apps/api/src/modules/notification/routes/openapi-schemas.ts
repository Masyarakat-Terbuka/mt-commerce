/**
 * Wire-shape schemas for the notification admin routes. Mirrors the runtime
 * serialization in `wire.ts`.
 */
import { z } from "@hono/zod-openapi";
import { paginated } from "../../../lib/openapi-shared.js";

export const NotificationWire = z
  .object({
    id: z.string(),
    channel: z.enum(["email", "whatsapp"]),
    kind: z.enum([
      "email_verification",
      "order_confirmation",
      "payment_received",
      "shipping_update",
      "password_reset",
    ]),
    recipient: z.string(),
    subject: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "sent", "failed"]),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Notification");

export const PaginatedNotificationWire = paginated(NotificationWire).openapi(
  "PaginatedNotification",
);

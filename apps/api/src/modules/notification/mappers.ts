/**
 * Drizzle row → notification domain type. Total mapping, no business
 * logic. Same pattern as the other modules.
 */
import type { NotificationRow } from "../../db/schema/index.js";
import type {
  Notification,
  NotificationChannelId,
  NotificationKind,
  NotificationStatus,
} from "./types.js";

export function toNotification(row: NotificationRow): Notification {
  // The DB stores channel/kind/status as `text`. We narrow at the boundary;
  // a row with an unknown value would be a programming error, but the cast
  // is safe because the writer is the same module.
  return {
    id: row.id,
    channel: row.channel as NotificationChannelId,
    kind: row.kind as NotificationKind,
    recipient: row.recipient,
    subject: row.subject ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as NotificationStatus,
    errorMessage: row.errorMessage ?? null,
    eventId: row.eventId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

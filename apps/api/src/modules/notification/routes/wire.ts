/**
 * Wire-shape helper — convert notification domain types to JSON-safe
 * payloads. Same rationale as the catalog and customer wire layers:
 * Date → ISO string, optional → null.
 */
import type { Notification } from "../types.js";

export interface WireNotification {
  id: string;
  channel: Notification["channel"];
  kind: Notification["kind"];
  recipient: string;
  subject: string | null;
  payload: Record<string, unknown>;
  status: Notification["status"];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toWireNotification(n: Notification): WireNotification {
  return {
    id: n.id,
    channel: n.channel,
    kind: n.kind,
    recipient: n.recipient,
    subject: n.subject,
    payload: n.payload,
    status: n.status,
    errorMessage: n.errorMessage,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

/**
 * Notification service — unit tests against in-memory fakes.
 *
 * Same pattern as the other module tests: construct
 * `NotificationServiceImpl` with a hand-rolled fake repository and a
 * fake channel (or a throwing one for the failure path).
 */
import { describe, expect, it } from "vitest";
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
  NotificationChannel,
  ChannelSendInput,
} from "../../../src/modules/notification/channels/types.js";
import type { NotificationChannelId } from "../../../src/modules/notification/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStore {
  rows: Map<string, NotificationRow>;
  clock: number;
}

function createStore(): FakeStore {
  return { rows: new Map(), clock: 0 };
}

function tick(store: FakeStore): Date {
  store.clock += 1;
  return new Date(Date.UTC(2026, 4, 7, 12, 0, store.clock));
}

function createFakeRepo(store: FakeStore): NotificationRepository {
  return {
    async insert(row: NewNotificationRow): Promise<NotificationRow> {
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
        createdAt: now,
        updatedAt: now,
      };
      store.rows.set(inserted.id, inserted);
      return inserted;
    },
    async getById(id: string): Promise<NotificationRow | null> {
      return store.rows.get(id) ?? null;
    },
    async list(
      filters: NotificationListFilters,
    ): Promise<NotificationListResult> {
      let rows = Array.from(store.rows.values());
      if (filters.channel) rows = rows.filter((r) => r.channel === filters.channel);
      if (filters.kind) rows = rows.filter((r) => r.kind === filters.kind);
      if (filters.status) rows = rows.filter((r) => r.status === filters.status);
      // Newest first, matching the real repository's ordering.
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

function createCapturingChannel(): NotificationChannel & {
  calls: ChannelSendInput[];
} {
  const calls: ChannelSendInput[] = [];
  return {
    id: "email",
    async send(input) {
      calls.push(input);
    },
    calls,
  };
}

function createThrowingChannel(message: string): NotificationChannel {
  return {
    id: "email",
    async send() {
      throw new Error(message);
    },
  };
}

function buildService(
  channel: NotificationChannel,
): { service: NotificationServiceImpl; store: FakeStore } {
  const store = createStore();
  const repo = createFakeRepo(store);
  const channels = new Map<NotificationChannelId, NotificationChannel>();
  channels.set("email", channel);
  const service = new NotificationServiceImpl({
    repository: repo,
    channels,
  });
  return { service, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotificationService.send — happy path", () => {
  it("renders the template, dispatches to the channel, and marks audit row sent", async () => {
    const channel = createCapturingChannel();
    const { service, store } = buildService(channel);

    const result = await service.send({
      channel: "email",
      recipient: "buyer@example.com",
      message: {
        kind: "email_verification",
        payload: { url: "https://example.com/verify/abc", name: "Budi" },
      },
    });

    // Audit row marked sent, no error message.
    expect(result.notification.status).toBe("sent");
    expect(result.notification.errorMessage).toBeNull();
    expect(result.notification.channel).toBe("email");
    expect(result.notification.kind).toBe("email_verification");
    expect(result.notification.recipient).toBe("buyer@example.com");

    // Channel saw the rendered triple, in Bahasa (default locale).
    expect(channel.calls).toHaveLength(1);
    const [call] = channel.calls;
    expect(call?.subject).toBe("Konfirmasi alamat email Anda");
    expect(call?.body).toContain("Halo Budi,");
    expect(call?.body).toContain("https://example.com/verify/abc");
    expect(call?.htmlBody).toContain("<a href=\"https://example.com/verify/abc\">");

    // Audit log persisted exactly one row.
    expect(store.rows.size).toBe(1);
  });

  it("uses the English template when locale='en'", async () => {
    const channel = createCapturingChannel();
    const { service } = buildService(channel);

    await service.send({
      channel: "email",
      recipient: "buyer@example.com",
      locale: "en",
      message: {
        kind: "email_verification",
        payload: { url: "https://example.com/verify/abc" },
      },
    });

    const [call] = channel.calls;
    expect(call?.subject).toBe("Confirm your email address");
    expect(call?.body).toContain("Please confirm your email address");
  });

  it("persists payload variables on the audit row for replay/debug", async () => {
    const channel = createCapturingChannel();
    const { service } = buildService(channel);

    const result = await service.send({
      channel: "email",
      recipient: "buyer@example.com",
      message: {
        kind: "email_verification",
        payload: { url: "https://example.com/verify/x", name: "Sari" },
      },
    });

    expect(result.notification.payload).toEqual({
      url: "https://example.com/verify/x",
      name: "Sari",
    });
    expect(result.notification.subject).toBe("Konfirmasi alamat email Anda");
  });
});

describe("NotificationService.send — failure path", () => {
  it("marks the audit row failed with error_message when the channel throws", async () => {
    const channel = createThrowingChannel("smtp connection refused");
    const { service, store } = buildService(channel);

    const result = await service.send({
      channel: "email",
      recipient: "buyer@example.com",
      message: {
        kind: "email_verification",
        payload: { url: "https://example.com/verify/x" },
      },
    });

    expect(result.notification.status).toBe("failed");
    expect(result.notification.errorMessage).toBe("smtp connection refused");
    // Audit row is the only persisted row — service does NOT retry.
    expect(store.rows.size).toBe(1);
  });

  it("does not throw on channel failure (fire-and-forget)", async () => {
    const channel = createThrowingChannel("boom");
    const { service } = buildService(channel);

    await expect(
      service.send({
        channel: "email",
        recipient: "buyer@example.com",
        message: {
          kind: "email_verification",
          payload: { url: "https://example.com/verify/x" },
        },
      }),
    ).resolves.toMatchObject({
      notification: { status: "failed" },
    });
  });
});

describe("NotificationService.sendOrThrow — request-path semantics", () => {
  it("re-throws on channel failure but still persists the audit row", async () => {
    const channel = createThrowingChannel("smtp down");
    const { service, store } = buildService(channel);

    await expect(
      service.sendOrThrow({
        channel: "email",
        recipient: "buyer@example.com",
        message: {
          kind: "email_verification",
          payload: { url: "https://example.com/verify/x" },
        },
      }),
    ).rejects.toThrow("smtp down");

    // Audit row exists and is marked failed.
    expect(store.rows.size).toBe(1);
    const [row] = Array.from(store.rows.values());
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("smtp down");
  });
});

describe("NotificationService.send — unknown channel", () => {
  it("marks the audit row failed when no adapter is registered for the channel id", async () => {
    // Build a service whose registry has NO channels.
    const store = createStore();
    const repo = createFakeRepo(store);
    const service = new NotificationServiceImpl({
      repository: repo,
      channels: new Map(),
    });

    const result = await service.send({
      channel: "email",
      recipient: "buyer@example.com",
      message: {
        kind: "email_verification",
        payload: { url: "https://example.com/verify/x" },
      },
    });

    expect(result.notification.status).toBe("failed");
    expect(result.notification.errorMessage).toContain("No channel registered");
  });
});

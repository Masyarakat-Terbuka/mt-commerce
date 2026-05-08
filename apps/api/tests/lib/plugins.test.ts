/**
 * Plugin loader integration tests.
 *
 * Coverage:
 *   - Lenient mode: a plugin throwing in `setup` is logged and skipped;
 *     subsequent plugins still load.
 *   - Strict mode: the same throw aborts boot.
 *   - Manifest validation: a plugin missing required fields is rejected.
 *   - Registration: registries (payment / shipping / notification /
 *     events) receive the right calls in order.
 *   - Config resolution lookup order, exercised through `resolveConfigPath`.
 *
 * The tests inject fakes for the four registries via `LoadPluginsOptions.deps`
 * so they do not touch the real `shippingService` / `notificationService`
 * singletons.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetLoadedPluginsForTesting,
  getLoadedPlugins,
  loadPlugins,
  resolveConfigPath,
  type PluginContextDeps,
} from "../../src/lib/plugins.js";
import {
  definePlugin,
  type DomainEventName,
  type DomainEventPayload,
  type NotificationChannel as PluginNotificationChannel,
  type PaymentProvider,
  type Plugin,
  type ShippingProvider as PluginShippingProvider,
} from "@mt-commerce/core/plugin";

function fakeDeps(): {
  deps: PluginContextDeps;
  payments: PaymentProvider[];
  shipping: PluginShippingProvider[];
  channels: PluginNotificationChannel[];
  subscriptions: Array<{ event: DomainEventName }>;
} {
  const payments: PaymentProvider[] = [];
  const shipping: PluginShippingProvider[] = [];
  const channels: PluginNotificationChannel[] = [];
  const subscriptions: Array<{ event: DomainEventName }> = [];

  const deps: PluginContextDeps = {
    registerPaymentProvider: (p) => {
      payments.push(p);
    },
    shippingService: {
      registerPluginProvider: (p: PluginShippingProvider) => {
        shipping.push(p);
      },
    } as unknown as PluginContextDeps["shippingService"],
    notificationService: {
      registerChannel: (c: PluginNotificationChannel) => {
        channels.push(c);
      },
    } as unknown as PluginContextDeps["notificationService"],
    subscribeToEvent: <E extends DomainEventName>(
      event: E,
      _listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
    ) => {
      subscriptions.push({ event });
      return () => undefined;
    },
  };
  return { deps, payments, shipping, channels, subscriptions };
}

beforeEach(() => {
  __resetLoadedPluginsForTesting();
  delete process.env.MT_COMMERCE_STRICT_PLUGINS;
});

describe("loadPlugins (inline config)", () => {
  it("skips load and returns empty when no plugins are configured", async () => {
    const result = await loadPlugins({
      inlineConfig: { plugins: [] },
      deps: fakeDeps().deps,
    });
    expect(result).toEqual([]);
    expect(getLoadedPlugins()).toEqual([]);
  });

  it("invokes each plugin's setup with the dependency-injected context", async () => {
    const { deps, channels, subscriptions } = fakeDeps();
    const plugin: Plugin = definePlugin({
      name: "@test/plug",
      version: "0.0.1",
      setup(ctx) {
        ctx.registerNotificationChannel({
          id: "test-channel",
          send: () => Promise.resolve(undefined),
        });
        ctx.on("order.placed", () => undefined);
      },
    });

    const result = await loadPlugins({
      inlineConfig: { plugins: [plugin] },
      deps,
    });
    expect(result).toEqual([
      { name: "@test/plug", version: "0.0.1" },
    ]);
    expect(channels.map((c) => c.id)).toEqual(["test-channel"]);
    expect(subscriptions.map((s) => s.event)).toEqual(["order.placed"]);
  });

  it("logs and skips a plugin whose setup throws (lenient mode)", async () => {
    const { deps, channels } = fakeDeps();
    const bad: Plugin = definePlugin({
      name: "@test/bad",
      version: "0.0.1",
      setup() {
        throw new Error("kaboom");
      },
    });
    const good: Plugin = definePlugin({
      name: "@test/good",
      version: "0.0.1",
      setup(ctx) {
        ctx.registerNotificationChannel({
          id: "ok",
          send: () => Promise.resolve(undefined),
        });
      },
    });

    const result = await loadPlugins({
      inlineConfig: { plugins: [bad, good] },
      deps,
    });
    expect(result.map((p) => p.name)).toEqual(["@test/good"]);
    expect(channels.map((c) => c.id)).toEqual(["ok"]);
  });

  it("rethrows in strict mode when a plugin's setup fails", async () => {
    const { deps } = fakeDeps();
    const bad: Plugin = definePlugin({
      name: "@test/bad",
      version: "0.0.1",
      setup() {
        throw new Error("kaboom");
      },
    });
    await expect(
      loadPlugins({ inlineConfig: { plugins: [bad] }, deps, strict: true }),
    ).rejects.toThrow("kaboom");
  });

  it("rejects a manifest missing required fields", async () => {
    const { deps } = fakeDeps();
    const malformed = { name: "no-setup", version: "0.0.1" } as unknown as Plugin;
    const result = await loadPlugins({
      inlineConfig: { plugins: [malformed] },
      deps,
    });
    expect(result).toEqual([]);
  });

  it("captures a teardown function the plugin returns from setup", async () => {
    const { deps } = fakeDeps();
    const teardown = vi.fn();
    const plugin: Plugin = definePlugin({
      name: "@test/teardown",
      version: "0.0.1",
      setup() {
        return teardown;
      },
    });
    const [entry] = await loadPlugins({
      inlineConfig: { plugins: [plugin] },
      deps,
    });
    expect(entry?.teardown).toBe(teardown);
    expect(teardown).not.toHaveBeenCalled(); // v0.1 does not invoke at boot
  });
});

describe("resolveConfigPath", () => {
  it("returns null when no candidate exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mtc-plugins-"));
    try {
      expect(resolveConfigPath({ cwd: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers an explicit override path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mtc-plugins-"));
    try {
      const override = join(dir, "custom.config.ts");
      writeFileSync(override, "export default {};\n");
      expect(
        resolveConfigPath({ cwd: dir, override: "custom.config.ts" }),
      ).toBe(override);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the override path does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mtc-plugins-"));
    try {
      expect(
        resolveConfigPath({ cwd: dir, override: "missing.config.ts" }),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the canonical apps/api/mt-commerce.config.ts location", () => {
    // Simulate cwd = apps/api/src; expects to find mt-commerce.config.ts
    // two levels up at <root>/mt-commerce.config.ts (the fallback) when
    // the canonical "apps/api/mt-commerce.config.ts" is also writable.
    const root = mkdtempSync(join(tmpdir(), "mtc-plugins-root-"));
    try {
      // <root>/apps/api/mt-commerce.config.ts (canonical) — when cwd is
      // <root>/apps/api the resolver should pick the canonical first.
      const apiDir = join(root, "apps", "api");
      mkdirSync(apiDir, { recursive: true });
      const canonical = join(apiDir, "mt-commerce.config.ts");
      writeFileSync(canonical, "export default {};\n");
      expect(resolveConfigPath({ cwd: apiDir })).toBe(canonical);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the workspace-root mt-commerce.config.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "mtc-plugins-fallback-"));
    try {
      const apiDir = join(root, "apps", "api");
      mkdirSync(apiDir, { recursive: true });
      const fallback = join(root, "mt-commerce.config.ts");
      writeFileSync(fallback, "export default {};\n");
      expect(resolveConfigPath({ cwd: apiDir })).toBe(fallback);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadPlugins (file-based config)", () => {
  it("info-logs and continues when the config file is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtc-plugins-absent-"));
    try {
      const result = await loadPlugins({
        cwd: dir,
        deps: fakeDeps().deps,
      });
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a config file that has a default-exported MtCommerceConfig", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtc-plugins-file-"));
    try {
      const apiDir = join(dir, "apps", "api");
      mkdirSync(apiDir, { recursive: true });
      const configPath = join(apiDir, "mt-commerce.config.ts");
      // Bun's dynamic-import resolves .ts files natively; the config can
      // be a tiny TS file that constructs a plugin inline.
      writeFileSync(
        configPath,
        `export default {
  plugins: [
    {
      name: "@test/from-file",
      version: "0.0.1",
      setup: () => undefined,
    },
  ],
};
`,
      );
      const result = await loadPlugins({
        cwd: apiDir,
        deps: fakeDeps().deps,
      });
      expect(result.map((p) => p.name)).toEqual(["@test/from-file"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

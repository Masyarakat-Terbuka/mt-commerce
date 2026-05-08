/**
 * Plugin loader. Reads `mt-commerce.config.ts`, builds a `PluginContext`
 * for each registered plugin, calls `setup(ctx)`, and tracks loaded
 * plugins for diagnostics (a future `/admin/v1/plugins` endpoint, plus
 * the `/health` snapshot).
 *
 * Lookup order for the config file (first hit wins):
 *
 *   1. `MT_COMMERCE_CONFIG` environment variable, treated as an absolute
 *      or workspace-relative path. Useful for tests, ephemeral overrides,
 *      and operators who want to keep the file outside the repo.
 *   2. `<workspace-root>/apps/api/mt-commerce.config.ts` — the canonical
 *      location. Lives next to the api so the operator's plugin set
 *      ships with the api deployment artifact.
 *   3. `<workspace-root>/mt-commerce.config.ts` — fallback for monorepo
 *      operators who keep their config at the repo root.
 *
 * Failure handling:
 *
 *   - Missing config file → empty plugin list, info-level log. Boot
 *     proceeds. This matches the "plugins are optional" stance — the
 *     platform must boot for an operator who has not adopted plugins yet.
 *
 *   - Config file present but the import throws → loader logs the error
 *     and (in lenient mode) proceeds with whatever plugins loaded before
 *     the throw. In strict mode (`MT_COMMERCE_STRICT_PLUGINS=true`) the
 *     loader rethrows.
 *
 *   - A plugin's `setup` throws → logged with the plugin name, skipped.
 *     Subsequent plugins still load. Strict mode rethrows here too.
 *
 *   - Two plugins try to register the same payment-provider code (or
 *     shipping code, or notification channel id) → the registry throws a
 *     `ConflictError` from inside the second plugin's `setup`; the loader
 *     treats it as a per-plugin failure under the rule above.
 *
 * Why dynamic import:
 *   - The config file is operator-supplied and may not exist. A static
 *     `import` would break compilation for every operator who never
 *     adopts a plugin.
 *   - Bun resolves TS files via dynamic `import()` natively, so we do
 *     not need a transpilation step at boot.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import type {
  DomainEventName,
  DomainEventPayload,
  MtCommerceConfig,
  NotificationChannel as PluginNotificationChannel,
  PaymentProvider,
  Plugin,
  PluginContext,
  PluginLogger,
  ShippingProvider as PluginShippingProvider,
} from "@mt-commerce/core/plugin";
import { childLogger, logger as rootLogger } from "./logger.js";
import { getNotificationService } from "../modules/notification/index.js";
import { shippingService as defaultShippingService } from "../modules/shipping/index.js";
import type { ShippingService } from "../modules/shipping/index.js";
import type { NotificationService } from "../modules/notification/index.js";
import { registerPaymentProvider as defaultRegisterPaymentProvider } from "./payments-registry.js";
import { subscribePluginListener as defaultSubscribePluginListener } from "./plugin-events.js";

const log = childLogger("plugins");

// ---------------------------------------------------------------------------
// Loaded-plugin manifest
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  /**
   * Optional teardown returned by the plugin's `setup`. Reserved for
   * future shutdown wiring; v0.1 does not invoke it.
   */
  readonly teardown?: () => void | Promise<void>;
}

const loaded: LoadedPlugin[] = [];

/** Snapshot of plugins that successfully registered. */
export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return [...loaded];
}

/** Test-only: drop the manifest. */
export function __resetLoadedPluginsForTesting(): void {
  loaded.length = 0;
}

// ---------------------------------------------------------------------------
// PluginContext factory
// ---------------------------------------------------------------------------

/**
 * Build the `PluginContext` for a single plugin. Each plugin gets its own
 * context object; closing over the plugin's name lets the logger and
 * error messages carry the plugin identifier without the plugin author
 * having to repeat it everywhere.
 *
 * Dependency injection: the four `register*` functions and the event
 * subscriber are parameters so tests can swap fakes. Production callers
 * use `createDefaultContext()` below.
 */
export interface PluginContextDeps {
  registerPaymentProvider: (provider: PaymentProvider) => void;
  shippingService: ShippingService;
  notificationService: NotificationService;
  subscribeToEvent: <E extends DomainEventName>(
    event: E,
    listener: (payload: DomainEventPayload<E>) => void | Promise<void>,
  ) => () => void;
}

function createPluginContext(
  plugin: Plugin,
  config: Record<string, unknown>,
  deps: PluginContextDeps,
): PluginContext {
  const pluginLog = childLogger("plugin").child({
    plugin: plugin.name,
  }) as unknown as PluginLogger;

  return {
    log: pluginLog,
    config,
    registerPaymentProvider(provider) {
      deps.registerPaymentProvider(provider);
    },
    registerShippingProvider(provider: PluginShippingProvider) {
      deps.shippingService.registerPluginProvider(provider);
    },
    registerNotificationChannel(channel: PluginNotificationChannel) {
      deps.notificationService.registerChannel(channel);
    },
    on(event, listener) {
      return deps.subscribeToEvent(event, listener);
    },
  };
}

function createDefaultDeps(): PluginContextDeps {
  return {
    registerPaymentProvider: defaultRegisterPaymentProvider,
    shippingService: defaultShippingService,
    notificationService: getNotificationService(),
    subscribeToEvent: defaultSubscribePluginListener,
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface ResolveConfigPathOptions {
  /** Working directory the loader resolves relative paths against. */
  readonly cwd: string;
  /** Optional explicit override (e.g. `MT_COMMERCE_CONFIG`). */
  readonly override?: string | undefined;
}

/**
 * Resolve the path to the operator's config file. Returns `null` when
 * none of the candidate locations exist; the loader treats this as
 * "no plugins configured" and continues.
 *
 * Exported for tests so they can assert the lookup order without
 * touching the file system.
 */
export function resolveConfigPath(
  opts: ResolveConfigPathOptions,
): string | null {
  if (opts.override && opts.override.trim() !== "") {
    const absolute = resolve(opts.cwd, opts.override);
    return existsSync(absolute) ? absolute : null;
  }
  // 1. apps/api/mt-commerce.config.ts (canonical)
  // 2. <workspace-root>/mt-commerce.config.ts (fallback)
  //
  // We try BOTH a TS extension and a JS extension under each path so a
  // pre-built / compiled config (uncommon, but possible) still resolves.
  const candidates = [
    resolve(opts.cwd, "mt-commerce.config.ts"),
    resolve(opts.cwd, "mt-commerce.config.js"),
    resolve(opts.cwd, "..", "..", "mt-commerce.config.ts"),
    resolve(opts.cwd, "..", "..", "mt-commerce.config.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Default `cwd` for resolution when the loader is invoked at boot.
 * Resolves relative to THIS source file so a developer running the api
 * from a different cwd (e.g. workspace root, or under `bun --filter`)
 * still finds `apps/api/mt-commerce.config.ts`.
 */
function defaultCwd(): string {
  // import.meta.url points at this compiled file (.../apps/api/src/lib/plugins.ts).
  // Three levels up = .../apps/api, which is the canonical config location:
  //   .../apps/api/src/lib/plugins.ts -> .../apps/api/src/lib -> .../apps/api/src -> .../apps/api
  const here = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(here)));
}

// ---------------------------------------------------------------------------
// Loader entry point
// ---------------------------------------------------------------------------

export interface LoadPluginsOptions {
  /** Working directory the loader resolves the config path against. */
  cwd?: string;
  /**
   * Strict mode rethrows the first plugin or config error and aborts
   * boot. Defaults to false — a misbehaving plugin should not crash an
   * otherwise-healthy api process.
   *
   * Operators who treat plugins as load-bearing infrastructure can opt in
   * with `MT_COMMERCE_STRICT_PLUGINS=true`.
   */
  strict?: boolean;
  /** Inject a config directly. When set, no file lookup happens. */
  inlineConfig?: MtCommerceConfig;
  /** Test-only — replace the registry-injection pieces. */
  deps?: PluginContextDeps;
}

/**
 * Load the operator's plugins. Returns the manifest of successfully-
 * loaded plugins (also retrievable later via `getLoadedPlugins()`).
 *
 * Idempotency: callers SHOULD invoke this once at boot. Calling it
 * twice will re-run every plugin's `setup`, which will re-register
 * providers and fail with `ConflictError`. Tests reset state between
 * cases via `__resetLoadedPluginsForTesting()` and the registry-
 * specific reset hooks.
 */
export async function loadPlugins(
  opts: LoadPluginsOptions = {},
): Promise<readonly LoadedPlugin[]> {
  const strict =
    opts.strict ?? process.env.MT_COMMERCE_STRICT_PLUGINS === "true";
  const deps = opts.deps ?? createDefaultDeps();

  let config: MtCommerceConfig | undefined;

  if (opts.inlineConfig) {
    config = opts.inlineConfig;
  } else {
    const cwd = opts.cwd ?? defaultCwd();
    const path = resolveConfigPath({
      cwd,
      override: process.env.MT_COMMERCE_CONFIG,
    });
    if (!path) {
      log.info(
        { cwd },
        "no mt-commerce.config.ts found — skipping plugin load",
      );
      return getLoadedPlugins();
    }
    try {
      // Bun resolves .ts via dynamic import natively. The `pathToFileURL`
      // wrap is what lets the resolver accept an absolute filesystem
      // path (otherwise it tries to interpret the leading slash as a
      // bare-module specifier).
      const url = pathToFileURL(path).href;
      const mod = (await import(url)) as { default?: MtCommerceConfig };
      if (!mod.default) {
        const message = `mt-commerce.config.ts at ${path} has no default export`;
        log.error({ path }, message);
        if (strict) throw new Error(message);
        return getLoadedPlugins();
      }
      config = mod.default;
      log.info({ path }, "loaded mt-commerce.config.ts");
    } catch (err) {
      log.error({ path, err }, "failed to import mt-commerce.config.ts");
      if (strict) throw err;
      return getLoadedPlugins();
    }
  }

  const plugins = config.plugins ?? [];
  for (const plugin of plugins) {
    await loadOne(plugin, deps, strict);
  }
  return getLoadedPlugins();
}

async function loadOne(
  plugin: Plugin,
  deps: PluginContextDeps,
  strict: boolean,
): Promise<void> {
  // Manifest sanity check. We accept anything with the right surface — a
  // plugin author MAY skip `definePlugin` and hand-roll the manifest, so
  // this is shape-driven rather than instanceof.
  if (
    typeof plugin?.name !== "string" ||
    typeof plugin?.version !== "string" ||
    typeof plugin?.setup !== "function"
  ) {
    const message =
      `plugin entry is missing required fields ` +
      `({ name, version, setup }) — got ${describePlugin(plugin)}`;
    log.error({ plugin }, message);
    if (strict) throw new Error(message);
    return;
  }

  const ctx = createPluginContext(plugin, /* config */ {}, deps);
  try {
    const maybeTeardown = await plugin.setup(ctx);
    const entry: LoadedPlugin =
      typeof maybeTeardown === "function"
        ? { name: plugin.name, version: plugin.version, teardown: maybeTeardown }
        : { name: plugin.name, version: plugin.version };
    loaded.push(entry);
    rootLogger.info(
      { plugin: plugin.name, version: plugin.version },
      `plugin ${plugin.name}@${plugin.version} loaded`,
    );
  } catch (err) {
    log.error(
      { plugin: plugin.name, version: plugin.version, err },
      `plugin ${plugin.name} failed to load`,
    );
    if (strict) throw err;
  }
}

function describePlugin(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  const candidate = value as { name?: unknown };
  if (typeof candidate.name === "string") return `<plugin "${candidate.name}">`;
  return "<plugin>";
}

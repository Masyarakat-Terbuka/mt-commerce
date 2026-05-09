/**
 * `@mt-commerce/plugin-example` — reference plugin.
 *
 * What it does:
 *   1. Registers a notification channel with id `"example"` that logs
 *      every send to the plugin logger. Useful for end-to-end smoke
 *      tests (the api can route a notification through the example
 *      channel to confirm plugin wiring works).
 *   2. Subscribes to `order.placed` and logs the order id + total. This
 *      exercises the event-listener extension point.
 *
 * Why it exists:
 *   - Proves the plugin shape works end-to-end (the integration tests in
 *     `apps/api/tests/lib/plugins.test.ts` use it as the under-test
 *     fixture, and an operator can drop it into `mt-commerce.config.ts`
 *     to confirm their api boots with plugins enabled).
 *   - Serves as the template plugin authors copy when starting a new
 *     plugin. The shape — factory `(opts) => Plugin` — is the
 *     recommended pattern; see the plugin author guide on the docs site.
 *
 * Keep this file short. Real plugins move per-extension code into their
 * own files under `src/`; the index stays as the manifest declaration.
 */
import {
  definePlugin,
  type NotificationChannel,
  type NotificationChannelSendInput,
  type Plugin,
  type PluginLogger,
} from "@mt-commerce/core/plugin";

export interface ExamplePluginOptions {
  /**
   * When `true`, the example channel logs at `info` level. When `false`
   * (default), it logs at `debug` so production deployments do not get
   * spammed if the channel is wired in by accident.
   */
  readonly verbose?: boolean;
}

/**
 * Notification channel that logs every send. The api's audit row records
 * the dispatch as `sent`; the channel itself just writes a log line. This
 * is the "console fallback" pattern, but exposed as a plugin to prove the
 * plugin channel-registration extension point.
 */
class ExampleNotificationChannel implements NotificationChannel {
  readonly id = "example" as const;

  constructor(
    private readonly log: PluginLogger,
    private readonly verbose: boolean,
  ) {}

  send(input: NotificationChannelSendInput): Promise<void> {
    const fields: Record<string, unknown> = {
      kind: input.kind,
      recipient: input.recipient,
      ...(input.subject ? { subject: input.subject } : {}),
    };
    if (this.verbose) {
      this.log.info(fields, "[plugin-example] notification delivered");
    } else {
      this.log.debug(fields, "[plugin-example] notification delivered");
    }
    return Promise.resolve();
  }
}

/**
 * Plugin factory. Operators import the default export and call it inside
 * `mt-commerce.config.ts`:
 *
 *   import examplePlugin from "@mt-commerce/plugin-example";
 *   export default defineConfig({
 *     plugins: [examplePlugin({ verbose: true })],
 *   });
 *
 * The factory pattern keeps operator options outside the manifest so
 * plugins can validate options eagerly (here we just default `verbose`).
 */
export default function examplePlugin(
  options: ExamplePluginOptions = {},
): Plugin {
  const verbose = options.verbose ?? false;
  return definePlugin({
    name: "@mt-commerce/plugin-example",
    version: "0.0.1",
    setup(ctx) {
      ctx.registerNotificationChannel(
        new ExampleNotificationChannel(ctx.log, verbose),
      );

      ctx.on("order.placed", (payload) => {
        ctx.log.info(
          {
            orderId: payload.orderId,
            orderNumber: payload.orderNumber,
            totalAmount: payload.totalAmount,
            currency: payload.currency,
          },
          "[plugin-example] order placed",
        );
      });

      ctx.log.info(
        { verbose },
        "[plugin-example] setup complete — channel and listener registered",
      );
    },
  });
}

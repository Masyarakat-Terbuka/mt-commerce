# @mt-commerce/plugin-example

Reference plugin for mt-commerce. Use this package as the template when
authoring a new plugin.

## What it does

- Registers a notification channel with id `"example"` that logs every
  send to the plugin logger. Useful as a smoke test for plugin wiring.
- Subscribes to `order.placed` and logs the order id and total.

## Usage

```ts
import { defineConfig } from "@mt-commerce/core/plugin";
import examplePlugin from "@mt-commerce/plugin-example";

export default defineConfig({
  plugins: [examplePlugin({ verbose: true })],
});
```

## Reference

For the full plugin authoring contract, see the
[plugin author guide](https://github.com/masyarakat-terbuka/mt-commerce/blob/main/apps/docs/src/content/docs/plugins/author-guide.mdx)
on the docs site.

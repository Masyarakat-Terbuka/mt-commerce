/**
 * Identity-helper smoke tests. `definePlugin` and `defineConfig` are
 * type-inference utilities — they return the value passed in unchanged.
 * The interesting checks are at the type level (exercised across the
 * codebase by the loader and the example plugin); these runtime tests
 * just pin the identity contract.
 */
import { describe, expect, it } from "vitest";
import {
  defineConfig,
  definePlugin,
  type Plugin,
  type PluginContext,
} from "../src/plugin.js";

describe("definePlugin", () => {
  it("returns the same object reference passed in", () => {
    const input: Plugin = {
      name: "@scope/plug",
      version: "1.0.0",
      setup: () => undefined,
    };
    const result = definePlugin(input);
    expect(result).toBe(input);
  });

  it("preserves the setup function as a callable", () => {
    let invoked = false;
    const plugin = definePlugin({
      name: "@scope/plug",
      version: "1.0.0",
      setup: () => {
        invoked = true;
      },
    });
    plugin.setup({} as unknown as PluginContext);
    expect(invoked).toBe(true);
  });
});

describe("defineConfig", () => {
  it("returns the same object reference passed in", () => {
    const input = { plugins: [] as Plugin[] };
    const result = defineConfig(input);
    expect(result).toBe(input);
  });

  it("accepts an empty config", () => {
    const result = defineConfig({});
    expect(result.plugins).toBeUndefined();
  });
});

/**
 * `@mt-commerce/core` — shared types and utilities.
 *
 * Importing from the package root pulls in everything; consumers who want to
 * minimize their import surface can use the subpath exports declared in
 * `package.json`:
 *
 *   import { add } from "@mt-commerce/core/money";
 *   import { id } from "@mt-commerce/core/ulid";
 *   import { CoreError } from "@mt-commerce/core/errors";
 *   import { definePlugin } from "@mt-commerce/core/plugin";
 */
export * from "./money.js";
export * from "./ulid.js";
export * from "./errors.js";
export * from "./plugin.js";

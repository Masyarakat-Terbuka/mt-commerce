// Conventional Commits with mt-commerce's whitelisted scopes.
//
// History note: some past commits use comma-separated multi-scope, e.g.
// `feat(api, core, plugins): ...`. Going forward we standardize on a single
// scope per commit (or no scope) to keep tooling simple. A commit that
// genuinely spans the whole repo can use `chore(repo): ...`.

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        // workspaces
        "api",
        "admin",
        "storefront",
        "core",
        "sdk",
        "plugins",
        // domains
        "auth",
        "catalog",
        "cart",
        "checkout",
        "customer",
        "notification",
        "orders",
        "payments",
        "shipping",
        "tax",
        "audit",
        "settings",
        // repository-wide work that does not fit a workspace or domain
        "repo",
        "deps",
        "ci",
        "docs",
      ],
    ],
    // Scope is encouraged but not required. A commit with no scope reads
    // fine in the changelog when the change is genuinely cross-cutting.
    "scope-empty": [0],
    "subject-case": [
      2,
      "never",
      ["sentence-case", "start-case", "pascal-case", "upper-case"],
    ],
  },
};

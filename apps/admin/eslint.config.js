import { reactConfig } from "@mt-commerce/eslint-config/react";

export default [
  ...reactConfig,
  {
    // shadcn/ui components are vendored from upstream and ship with mixed
    // exports (component + variants/contexts) by design. Fast-refresh would
    // ideally have these split, but the trade-off (drift from upstream every
    // time we sync, plus re-exports on every site) is not worth it.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
];

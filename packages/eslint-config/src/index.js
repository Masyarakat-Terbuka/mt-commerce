// Default export points at the base preset; named exports expose the
// frontend-specific layered presets. Most consumers will import the
// subpath that matches their app type.

export { baseConfig } from "./base.js";
export { reactConfig } from "./react.js";
export { astroConfig } from "./astro.js";
export { default } from "./base.js";

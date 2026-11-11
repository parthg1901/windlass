// The product name is not final. Everything that shows or depends on the name reads it
// from here, so a rename is a change to this file (plus the package names and the binary).
export const brand = {
  /** Display name, also sent as the client name when registering with ChatGPT sign-in. */
  name: "light-harness",
  /** Command-line binary. */
  binary: "lh",
  /** Directory name under the user's data and config directories. */
  directory: "light-harness",
  /** Prefix for protocol extension methods, e.g. `_light-harness/steer`. */
  extensionPrefix: "_light-harness",
} as const

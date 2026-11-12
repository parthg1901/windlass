// The product name is not final. Everything that shows or depends on the name reads it
// from here, so a rename is a change to this file (plus the package names and the binary).
export const brand = {
  /** Display name, also sent as the client name when registering with ChatGPT sign-in. */
  name: "light-harness",
  /** Command-line binary. */
  binary: "lh",
  /** Other names for the same program (installed beside the binary, and in the CLI package's `bin` map). */
  aliases: [] as readonly string[],
  /** Directory name under the user's data and config directories. */
  directory: "light-harness",
  /** Prefix for protocol extension methods, e.g. `_light-harness/steer`. */
  extensionPrefix: "_light-harness",
  /** Prefix of every environment variable the program reads or sets, e.g. `LH_TUI`. */
  envPrefix: "LH_",
} as const

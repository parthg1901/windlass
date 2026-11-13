// Everything that shows or depends on the product's name reads it from here, so a rename is
// a change to this file (plus the package names and the binary).
export const brand = {
  /** Display name, also sent as the client name when registering with ChatGPT sign-in. */
  name: "Windlass",
  /** Command-line binary. */
  binary: "windlass",
  /** Other names for the same program (installed beside the binary, and in the CLI package's `bin` map). */
  aliases: ["wl"] as readonly string[],
  /** Directory name under the user's data and config directories. */
  directory: "windlass",
  /** Prefix for protocol extension methods, e.g. `_windlass/steer`. */
  extensionPrefix: "_windlass",
  /** Prefix of every environment variable the program reads or sets, e.g. `WINDLASS_TUI`. */
  envPrefix: "WINDLASS_",
  /**
   * The package on npm that installs the binary and its aliases (`npm install -g <it>`). Each target's
   * executable is in a package of its own, `<it>-<os>-<arch>` (scripts/npm.ts, npm/README.md).
   */
  npmPackage: "windlass-agent",
  /** The GitHub repository, `<owner>/<repo>`: releases, and the `repository` field of the npm packages. */
  repository: "parthg1901/windlass",
} as const

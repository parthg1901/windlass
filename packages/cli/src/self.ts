/**
 * How this program starts itself again (the ACP server child of the CLI and
 * of the full-screen interface). From source that is this Bun running
 * `main.ts`; a compiled executable is its own runtime, so it is the
 * executable alone: passing a script path to it would make the path its
 * first argument.
 */
import { buildStamp } from "@light-harness/core"

const MAIN = new URL("./main.ts", import.meta.url).pathname

/** Whether this is a compiled executable (`bun build --compile`) rather than Bun running the source. */
export function compiled(): boolean {
  // The stamp says so for the build script's executables; the embedded file system's path for any other compile.
  return buildStamp() !== null || import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN")
}

/** The command line that runs this program with `args` (e.g. `["acp"]`). */
export function selfCommand(args: readonly string[]): string[] {
  return compiled() ? [process.execPath, ...args] : [process.execPath, MAIN, ...args]
}

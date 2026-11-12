/**
 * The program's version and identity, one string everywhere: `--version`,
 * `initialize` over the protocol (agent and client info), and the user agent
 * the model provider sees. The number is the workspace's package version; a
 * compiled executable adds the commit it was built from (and `.dirty` when
 * the tree had uncommitted changes), a run from source adds `+source`.
 */
import workspace from "../../../package.json" with { type: "json" }
import { brand } from "./brand.ts"
import { BUILD_STAMP, type BuildStamp } from "./build-stamp.ts"

export type { BuildStamp } from "./build-stamp.ts"

/** The stamp of this executable, or `null` when running from source. */
export const buildStamp = (): BuildStamp | null => BUILD_STAMP

/** E.g. `0.1.0+3f2a9c1`, `0.1.0+3f2a9c1.dirty`, or `0.1.0+source`. */
export function versionString(stamp: BuildStamp | null = BUILD_STAMP, base: string = workspace.version): string {
  return stamp === null ? `${base}+source` : `${base}+${stamp.commit}${stamp.dirty ? ".dirty" : ""}`
}

/** Where this process runs, as `<os>-<arch>` (Node's names: `linux-arm64`, `darwin-x64`). */
export const platformString = (): string => `${process.platform}-${process.arch}`

/** The line `--version` prints. */
export function versionLine(stamp: BuildStamp | null = BUILD_STAMP): string {
  const without = stamp !== null && !stamp.tui ? ", without the full-screen interface" : ""
  return `${brand.name} ${versionString(stamp)} (${platformString()}${without})`
}

/** The `User-Agent` sent to the model provider. */
export const userAgent = (): string => `${brand.name}/${versionString()} (${process.platform}; ${process.arch})`

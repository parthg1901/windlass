/**
 * What `scripts/build.ts` knows when it compiles an executable. The build
 * replaces this module's contents with the real stamp; from source it is
 * `null`, and the version says `+source`.
 */
export interface BuildStamp {
  /** The git commit the executable was built from, abbreviated. */
  readonly commit: string
  /** Whether the working tree had changes that are not in that commit. */
  readonly dirty: boolean
  /** The Bun compile target, e.g. `bun-linux-arm64`. */
  readonly target: string
  /** Whether the full-screen interface (and its native library) is in this executable. */
  readonly tui: boolean
}

export const BUILD_STAMP: BuildStamp | null = null

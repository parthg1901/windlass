/**
 * Stands in for `@windlass/tui` in an executable built without the
 * full-screen interface (`scripts/build.ts` swaps it in when OpenTUI's native
 * library for the target is not available to embed). `tui` then says so and
 * fails instead of crashing on a missing library.
 */
import { brand, buildStamp } from "@windlass/core"

export async function runTui(_options: unknown): Promise<number> {
  const target = buildStamp()?.target.replace(/^bun-/, "") ?? `${process.platform}-${process.arch}`
  process.stderr.write(
    `${brand.binary}: the full-screen interface is not part of this build: it was built for ${target} without OpenTUI's native library for that platform. ` +
      `The line interface is the same agent: run \`${brand.binary}\` without \`tui\`.\n`,
  )
  return 1
}

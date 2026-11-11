/**
 * A fingerprint of what a check's result depends on, as far as the harness can
 * see cheaply: the command, the timeout, and the size and modification time
 * (nanoseconds) of each changed file the check is selected by. The loop stores
 * it with a passing result and skips the check while the fingerprint is the same.
 *
 * What it misses (a skipped check could then be stale):
 * - a file rewritten with the same size and the same mtime: a tool that
 *   restores mtimes (`touch -r`, `cp -p`, some archive tools), or a coarse
 *   file system clock (FAT, some network mounts, 1 s or 2 s granularity);
 * - anything the check reads that is not in the changed-file list: files
 *   outside `when`, files changed by something other than the agent's tools,
 *   dependencies, generated files, environment variables, tool versions, the clock
 *   and the network;
 * - a flaky check, which can fail on unchanged inputs.
 * A missing file is part of the fingerprint, so a deletion changes it.
 */
import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { CheckConfig } from "../config/schema.ts"
import { filesFor } from "./select.ts"

export async function fingerprintCheck(check: CheckConfig, changedFiles: readonly string[], cwd: string): Promise<string> {
  const files = await Promise.all(
    filesFor(check, changedFiles).map(async (file) => {
      const info = await stat(join(cwd, file), { bigint: true }).catch(() => null)
      return info === null ? [file, null] : [file, String(info.size), String(info.mtimeNs)]
    }),
  )
  const material = JSON.stringify(["v1", check.command, check.timeoutSeconds, files])
  return new Bun.CryptoHasher("sha256").update(material).digest("hex")
}

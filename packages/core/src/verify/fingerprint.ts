/**
 * A fingerprint of what a check's result depends on, as far as the check
 * declares it: the command, the timeout, its `when` patterns, and the content
 * (SHA-256) of every changed file those patterns select. The loop stores it
 * with each result, and does not run a check again while the fingerprint is
 * the one it last passed with (`reusablePass`).
 *
 * It hashes content, not size and modification time: a file rewritten within
 * one tick of a coarse clock, or by a tool that restores timestamps, would
 * otherwise look unchanged. The files are the changed ones only, so this
 * reads little.
 *
 * What it cannot see, and how reuse stays on the safe side of it:
 * - anything the check reads that its `when` patterns do not name
 *   (dependencies, generated or ignored files, environment variables, tool
 *   versions, the clock, the network). A check without `when` says it depends
 *   on everything, so its pass is never carried over. A check with `when`
 *   says what it depends on, and is taken at its word;
 * - a flaky check, which can fail on unchanged inputs: only a pass is ever
 *   carried, so flakiness can only cost a re-run, never hide a failure that
 *   was seen;
 * - a file that cannot be read: its fingerprint entry is unique per call, so
 *   the fingerprint never matches and the check runs.
 * A missing file is part of the fingerprint, so a deletion changes it.
 */
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { CheckConfig } from "../config/schema.ts"
import type { CheckEvidence } from "./evidence.ts"
import { filesFor } from "./select.ts"

export async function fingerprintCheck(check: CheckConfig, changedFiles: readonly string[], cwd: string): Promise<string> {
  const files = await Promise.all(filesFor(check, changedFiles).map(async (file) => [file, await contentHash(join(cwd, file))]))
  const material = JSON.stringify(["v2", check.command, check.timeoutSeconds, check.when, files])
  return new Bun.CryptoHasher("sha256").update(material).digest("hex")
}

/** The SHA-256 of a file's bytes, `null` when there is no such file, and a value that never repeats when it cannot be read. */
async function contentHash(path: string): Promise<string | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    const hasher = new Bun.CryptoHasher("sha256")
    for await (const chunk of file.stream()) hasher.update(chunk)
    return hasher.digest("hex")
  } catch {
    return `unreadable:${randomBytes(16).toString("hex")}`
  }
}

/**
 * The earlier pass of `check` that still stands, as the `seq` of the
 * `checks.finished` that recorded it, or `null` when the check has to run.
 * When in doubt it runs: a pass is carried over only if
 * - the check names what it depends on (`when`);
 * - the changed files are known from a snapshot diff (`changedFilesKnown`),
 *   not guessed from which tools ran;
 * - its latest recorded result is a pass, and that run measured changes from
 *   the same verified state as this one does (`sameBaseline`), so both
 *   fingerprints cover the same set of files;
 * - the fingerprint is the same.
 */
export function reusablePass(input: {
  readonly check: CheckConfig
  readonly fingerprint: string
  readonly changedFilesKnown: boolean
  readonly sameBaseline: boolean
  /** The latest recorded run of checks and the `seq` of its `checks.finished`. */
  readonly latest: { readonly seq: number; readonly checks: readonly CheckEvidence[] } | null
}): number | null {
  if (input.check.when === null || !input.changedFilesKnown || !input.sameBaseline || input.latest === null) return null
  const previous = input.latest.checks.find((result) => result.name === input.check.name)
  if (previous === undefined || previous.status !== "passed" || previous.fingerprint === "" || previous.fingerprint !== input.fingerprint) return null
  return previous.reusedFromSeq ?? input.latest.seq
}

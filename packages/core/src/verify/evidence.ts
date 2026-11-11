/**
 * What one run of checks showed, as a record the step loop can attach to a
 * durable event (for example the turn's completion) so that "done" can be shown
 * to rest on something. Declared with the project's strict validators, like
 * every stored type: no optional keys, absent values are `null`.
 */
import type { CheckConfig } from "../config/schema.ts"
import { type Infer, array, integer, nonEmptyString, nullable, object, string } from "../validate.ts"
import { filesFor } from "./select.ts"
import type { CheckResult } from "./run.ts"
import { checkStatus } from "./status.ts"

export const checkEvidence = object({
  name: nonEmptyString,
  command: string,
  status: checkStatus,
  exitCode: nullable(integer()),
  signal: nullable(string),
  durationMs: integer(0),
  /** The changed files that selected this check, sorted. */
  files: array(string),
  /** `fingerprintCheck` at the time the check ran. */
  fingerprint: nonEmptyString,
  /** The full output, named by its content. */
  outputPath: nullable(string),
  outputBytes: integer(0),
  outputLines: integer(0),
})
export type CheckEvidence = Infer<typeof checkEvidence>

export const verificationEvidence = object({
  /** 1 for the first run of checks in the turn, then 2, ... */
  run: integer(1),
  /** The `seq` of the latest durable event of the session when the checks started. */
  afterSeq: integer(0),
  /** Every file changed since the last fully passing verification, sorted. */
  changedFiles: array(string),
  checks: array(checkEvidence),
})
export type VerificationEvidence = Infer<typeof verificationEvidence>

export function buildEvidence(input: {
  readonly run: number
  readonly afterSeq: number
  readonly changedFiles: readonly string[]
  readonly checks: readonly CheckConfig[]
  readonly results: readonly CheckResult[]
  /** By check name, computed when the run started. */
  readonly fingerprints: Readonly<Record<string, string>>
}): VerificationEvidence {
  return verificationEvidence(
    {
      run: input.run,
      afterSeq: input.afterSeq,
      changedFiles: [...new Set(input.changedFiles)].sort(),
      checks: input.results.map((result) => {
        const config = input.checks.find((check) => check.name === result.name)
        return {
          name: result.name,
          command: result.command,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          files: config === undefined ? [] : filesFor(config, input.changedFiles),
          fingerprint: input.fingerprints[result.name] ?? "",
          outputPath: result.output.path,
          outputBytes: result.output.totalBytes,
          outputLines: result.output.totalLines,
        }
      }),
    },
    "evidence",
  )
}

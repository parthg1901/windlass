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
  /**
   * `null` when the check ran in this run. Otherwise it did not: it passed
   * in an earlier run, recorded by the `checks.finished` at this `seq`, and
   * what it depends on is byte for byte what it was then (the same
   * `fingerprint`), so that result was carried over. Only a pass is ever carried.
   */
  reusedFromSeq: nullable(integer(1)),
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
  /** Checks that were not run because their last pass still stands, with the `seq` that pass was recorded at. */
  readonly reused?: readonly { readonly check: CheckConfig; readonly fromSeq: number }[]
}): VerificationEvidence {
  const carried = (input.reused ?? []).map(({ check, fromSeq }): CheckEvidence => ({
    name: check.name,
    command: check.command,
    status: "passed" as const,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    files: filesFor(check, input.changedFiles),
    fingerprint: input.fingerprints[check.name] ?? "",
    reusedFromSeq: fromSeq,
    outputPath: null,
    outputBytes: 0,
    outputLines: 0,
  }))
  const order = new Map(input.checks.map((check, index) => [check.name, index]))
  return verificationEvidence(
    {
      run: input.run,
      afterSeq: input.afterSeq,
      changedFiles: [...new Set(input.changedFiles)].sort(),
      checks: input.results.map((result): CheckEvidence => {
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
          reusedFromSeq: null,
          outputPath: result.output.path,
          outputBytes: result.output.totalBytes,
          outputLines: result.output.totalLines,
        }
      })
        .concat(carried)
        // The configuration's order, whether a check ran or was carried over.
        .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)),
    },
    "evidence",
  )
}

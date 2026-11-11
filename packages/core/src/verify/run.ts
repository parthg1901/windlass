/**
 * Runs checks through the shell tool (its process group, timeout, abort and
 * grace period, and its bounded-memory spill of the output), then classifies
 * the outcome and keeps the full output in a file named by its content.
 *
 * Content-addressed output files make the result reproducible: the same
 * output gives the same path, so the model-facing text of a check that fails
 * the same way twice is byte-identical. The duration varies and is kept only
 * in structured data.
 *
 * Exit codes 126 and 127 (the shell could not execute the command, or found no
 * such command) count as "could not start", like a shell that cannot be
 * spawned: the check itself is broken, which the model may not be able to fix.
 * A test runner that exits 126 or 127 for its own reasons is misclassified.
 */
import { rename } from "node:fs/promises"
import { join } from "node:path"
import type { CheckConfig } from "../config/schema.ts"
import { callId, messageId, sessionId } from "../id.ts"
import { type InterruptReason, interruptReason, interruptReasonOf } from "../interrupt.ts"
import type { Json } from "../json.ts"
import { type CapSource, countLines } from "../tool/cap.ts"
import type { ToolResult } from "../tool/tool.ts"
import { shellTool } from "../tools/shell.ts"
import { boolean, integer, nullable, object, oneOf, safeDecode, string, type Infer } from "../validate.ts"

export const checkStatus = oneOf(["passed", "failed", "timed_out", "could_not_start", "interrupted"])
export type CheckStatus = Infer<typeof checkStatus>

/** A status that means the check did not pass. `interrupted` is not one: the check did not finish. */
export function isFailure(status: CheckStatus): boolean {
  return status === "failed" || status === "timed_out" || status === "could_not_start"
}

export interface CheckOutput {
  /** Everything the command printed, stdout and stderr interleaved as they arrived. */
  readonly totalBytes: number
  readonly totalLines: number
  /** The file holding the full output, or `null` when the command never started. */
  readonly path: string | null
  /** How much of the output the file holds; less than `totalBytes` only past the shell's spill limit. */
  readonly savedBytes: number
  /** The first and last bytes, enough for `renderOutput` at any limit up to `OUTPUT_LIMITS`. */
  readonly source: CapSource
}

export interface CheckResult {
  readonly name: string
  readonly command: string
  readonly timeoutSeconds: number
  readonly status: CheckStatus
  readonly exitCode: number | null
  /** The signal that ended the command, when it did not exit by itself. */
  readonly signal: string | null
  readonly interruptedBy: InterruptReason | null
  /** Why the shell could not be spawned (for example the directory does not exist). */
  readonly startError: string | null
  /** Never part of the model-facing text. */
  readonly durationMs: number
  readonly output: CheckOutput
}

export interface RunCheckOptions {
  /** The project directory. */
  readonly cwd: string
  /** Where full outputs are kept. Created on first use. */
  readonly spillDir: string
  /** From `createInterrupt`; aborting it stops the running check and skips the rest. */
  readonly signal: AbortSignal
  readonly shell?: string
  readonly graceMs?: number
  readonly spillLimitBytes?: number
  /** Ephemeral progress (the tail of the running check's output), for display only. */
  readonly progress?: (check: string, text: string) => void
}

/** Runs checks one after another, in the given order. Once interrupted, the remaining checks are reported as interrupted without running. */
export async function runChecks(checks: readonly CheckConfig[], options: RunCheckOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  // Sequential on purpose: checks often share build output and would contend if run together.
  for (const check of checks) results.push(await runCheck(check, options))
  return results
}

export async function runCheck(check: CheckConfig, options: RunCheckOptions): Promise<CheckResult> {
  const startedAt = performance.now()
  const early = interruptReasonOf(options.signal)
  if (early !== null) return { ...notStarted(check), status: "interrupted", interruptedBy: early }

  const tool = shellTool({ spillDir: options.spillDir, shell: options.shell, graceMs: options.graceMs, spillLimitBytes: options.spillLimitBytes })
  const result = await tool.execute(
    { command: check.command, timeout: check.timeoutSeconds },
    {
      sessionId: sessionId("verify", ""),
      messageId: messageId("verify", ""),
      // Fixes the shell's working spill file name per check; it is renamed by content below.
      callId: callId(`check-${check.name}`, ""),
      cwd: options.cwd,
      signal: options.signal,
      progress: (update) => options.progress?.(check.name, update.text),
    },
  )
  const durationMs = Math.round(performance.now() - startedAt)
  const display = readDisplay(result.display)
  if (!display.started)
    return { ...notStarted(check), status: "could_not_start", startError: result.output.replace(/^Could not start the command: /, ""), durationMs }

  return {
    name: check.name,
    command: check.command,
    timeoutSeconds: check.timeoutSeconds,
    status: statusOf(display),
    exitCode: display.exitCode,
    signal: display.signal,
    interruptedBy: display.interrupted,
    startError: null,
    durationMs,
    output: await keepOutput(result, hasStatusLine(display), options.spillDir, check.name),
  }
}

const HEAD_KEEP = 64 * 1024
const TAIL_KEEP = 64 * 1024
const encoder = new TextEncoder()

/** The full output, moved or written to `check-<name>-<sha256>.log`, and the head and tail of it. */
async function keepOutput(result: ToolResult, statusLine: boolean, spillDir: string, name: string): Promise<CheckOutput> {
  const truncation = result.truncation
  const spillPath = truncation?.spillPath ?? null
  if (truncation === null || spillPath === null) {
    const bytes = encoder.encode(withoutStatusLine(result.output, statusLine))
    const path = join(spillDir, outputName(name, new Bun.CryptoHasher("sha256").update(bytes).digest("hex")))
    await Bun.write(path, bytes)
    return { totalBytes: bytes.length, totalLines: countLines(bytes), path, savedBytes: bytes.length, source: whole(bytes) }
  }
  const file = Bun.file(spillPath)
  if (file.size < truncation.originalBytes) {
    // The spill file stopped at its size limit, so the end of the output exists only in the shell's own capped
    // text. Show that text as it is; the file keeps its working name and is replaced the next time this check runs.
    const bytes = encoder.encode(withoutStatusLine(result.output, statusLine))
    return { totalBytes: bytes.length, totalLines: countLines(bytes), path: spillPath, savedBytes: file.size, source: whole(bytes) }
  }
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of file.stream()) hasher.update(chunk)
  const path = join(spillDir, outputName(name, hasher.digest("hex")))
  const head = new Uint8Array(await file.slice(0, HEAD_KEEP).arrayBuffer())
  // One byte more than the tail, to know whether the tail starts a line.
  const before = new Uint8Array(await file.slice(Math.max(0, file.size - TAIL_KEEP - 1)).arrayBuffer())
  await rename(spillPath, path)
  const short = file.size <= TAIL_KEEP
  return {
    totalBytes: truncation.originalBytes,
    totalLines: truncation.originalLines,
    path,
    savedBytes: truncation.originalBytes,
    source: {
      head,
      tail: short ? before : before.subarray(1),
      tailAtLineStart: short || before[0] === 0x0a,
      totalBytes: truncation.originalBytes,
      totalLines: truncation.originalLines,
    },
  }
}

function whole(bytes: Uint8Array): CapSource {
  return { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines: countLines(bytes) }
}

function outputName(name: string, sha: string) {
  return `check-${name}-${sha.slice(0, 32)}.log`
}

/**
 * The shell's text without the status line it appends (`[Exit code 1]` and the like): the status is reported
 * separately. The line is present exactly when the command did not exit 0 by itself, and is the last line.
 */
function withoutStatusLine(output: string, statusLine: boolean) {
  const text = statusLine ? output.slice(0, output.lastIndexOf("\n") + 1) : output
  return text === "(no output)" || text === "(no output)\n" ? "" : text
}

const finishedDisplay = object({
  exitCode: nullable(integer()),
  signal: nullable(string),
  timedOut: boolean,
  interrupted: nullable(interruptReason),
  durationMs: integer(0),
})
const notStartedDisplay = object({ exitCode: nullable(integer()), signal: nullable(string), timedOut: boolean, interrupted: nullable(interruptReason) })

/** The shell's `display`, decoded once. Without `durationMs` it is the shape of a spawn failure. */
function readDisplay(display: Json | null) {
  const finished = safeDecode(finishedDisplay, display)
  if (finished.ok) return { started: true as const, ...finished.value }
  return { started: false as const, ...notStartedDisplay(display, "shell display") }
}

function hasStatusLine(display: Infer<typeof finishedDisplay>) {
  return display.timedOut || display.interrupted !== null || display.signal !== null || display.exitCode !== 0
}

function statusOf(display: Infer<typeof finishedDisplay>): CheckStatus {
  if (display.interrupted !== null) return "interrupted"
  if (display.timedOut) return "timed_out"
  if (display.signal !== null) return "failed"
  if (display.exitCode === 0) return "passed"
  if (display.exitCode === 126 || display.exitCode === 127) return "could_not_start"
  return "failed"
}

function notStarted(check: CheckConfig): CheckResult {
  const empty = new Uint8Array(0)
  return {
    name: check.name,
    command: check.command,
    timeoutSeconds: check.timeoutSeconds,
    status: "could_not_start",
    exitCode: null,
    signal: null,
    interruptedBy: null,
    startError: null,
    durationMs: 0,
    output: { totalBytes: 0, totalLines: 0, path: null, savedBytes: 0, source: whole(empty) },
  }
}

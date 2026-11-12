/**
 * Running a wake-up's check command, with no model call. The default runner goes through the verification gate's
 * runner (`../verify/run.ts`), which runs it through the shell tool: its own process group, the timeout, SIGTERM
 * then SIGKILL to the group, a guard that kills the group if this process dies, and the output kept as a bounded
 * head and tail however much is printed. A command recorded as sandboxed runs in the sandbox with exactly the
 * recorded access, or not at all: where the sandbox is unavailable the run is an error, never an unsandboxed run.
 */
import { rm } from "node:fs/promises"
import { type RedactedPiece, redactPieces } from "../approval/redact.ts"
import { createInterrupt } from "../interrupt.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import { isContinuation, markerAround } from "../tool/cap.ts"
import { runCheck } from "../verify/run.ts"
import type { RunAs } from "./record.ts"

export interface CheckRequest {
  /** Names the run's files; the wake-up's ID. */
  readonly name: string
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  /** Already narrowed (`narrowRun`): never more than was approved at creation. */
  readonly run: RunAs
  readonly sessionId: string
  /** Aborted by the scheduler's `stop`. */
  readonly signal: AbortSignal
}

export type CheckOutcome =
  /** It ran to its end. `output` is capped and redacted; `fingerprint` covers the whole output and the exit code. */
  | { readonly kind: "exited"; readonly exitCode: number; readonly output: string; readonly totalBytes: number; readonly fingerprint: string }
  /** It could not complete. Counts towards `maxConsecutiveErrors`. */
  | { readonly kind: "error"; readonly reason: "timed_out" | "killed" | "could_not_start" | "sandbox_unavailable"; readonly message: string; readonly output: string }
  /** Stopped by `stop`; nothing is recorded and it runs again later. */
  | { readonly kind: "interrupted" }

export type CheckRunner = (request: CheckRequest) => Promise<CheckOutcome>

export interface CheckRunnerOptions {
  /** Where outputs are written while a check runs; each is deleted afterwards. */
  readonly spillDir: string
  /** Required to run anything recorded as sandboxed. */
  readonly sandbox?: CommandSandbox
  readonly shell?: string
  readonly graceMs?: number
  /** How much of the output a firing shows. Default 4096 bytes: the beginning and the end. */
  readonly shownBytes?: number
  /** Values to redact wherever they occur, e.g. credential environment values (see `../approval/redact.ts`). */
  readonly secrets?: () => readonly string[]
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function createCheckRunner(options: CheckRunnerOptions): CheckRunner {
  const shownBytes = options.shownBytes ?? 4096
  return async (request) => {
    if (request.signal.aborted) return { kind: "interrupted" }
    const sandboxed = request.run.kind === "sandboxed"
    if (sandboxed && (options.sandbox === undefined || !options.sandbox.state.available)) {
      const why = options.sandbox === undefined || options.sandbox.state.available ? "this build has none" : options.sandbox.state.reason
      return { kind: "error", reason: "sandbox_unavailable", message: `it must run in the sandbox, which is unavailable: ${why}`, output: "" }
    }
    // The gate's runner takes an interrupt token; forward the scheduler's signal to one.
    const interrupt = createInterrupt()
    const forward = () => interrupt.interrupt("shutdown")
    request.signal.addEventListener("abort", forward, { once: true })
    try {
      const result = await runCheck(
        { name: request.name, command: request.command, timeoutSeconds: Math.max(1, Math.ceil(request.timeoutMs / 1000)), when: null },
        {
          cwd: request.cwd,
          spillDir: options.spillDir,
          signal: interrupt.signal,
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
          spillLimitBytes: 16 * 1024 * 1024,
          ...(sandboxed && request.run.kind === "sandboxed"
            ? { sandbox: { sandbox: options.sandbox!, run: { network: request.run.network, writableRoots: [...request.run.writableRoots] }, sessionId: request.sessionId } }
            : {}),
        },
      )
      const path = result.output.path
      const fingerprint = await (async () => {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(`${result.exitCode ?? result.signal ?? result.status}\n`)
        if (path !== null) for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
        return hasher.digest("hex")
      })()
      if (path !== null) await rm(path, { force: true })
      const output = shown(result.output.source, shownBytes, options.secrets?.() ?? [])
      switch (result.status) {
        case "passed":
        case "failed":
          if (result.exitCode !== null) return { kind: "exited", exitCode: result.exitCode, output, totalBytes: result.output.totalBytes, fingerprint }
          return { kind: "error", reason: "killed", message: `it was killed by signal ${result.signal ?? "unknown"}`, output }
        case "timed_out":
          return { kind: "error", reason: "timed_out", message: `it did not finish within ${Math.ceil(request.timeoutMs / 1000)} seconds`, output }
        case "could_not_start":
          return { kind: "error", reason: "could_not_start", message: result.startError ?? `the shell could not run it (exit ${result.exitCode})`, output }
        case "interrupted":
          return { kind: "interrupted" }
      }
    } finally {
      request.signal.removeEventListener("abort", forward)
    }
  }
}

/**
 * All of the output when it fits, else its beginning and end around a line that says how much is left out, redacted.
 * Each end is redacted before it is cut (the runner keeps far more of each than is shown), and the cut falls on a
 * character boundary and never inside a placeholder, as the tool output cap's does: a value that lies across the cut
 * is replaced whole, never shown in part. The count left out is in bytes of the output as it was printed.
 */
function shown(source: { readonly head: Uint8Array; readonly tail: Uint8Array; readonly totalBytes: number }, limit: number, secrets: readonly string[]): string {
  const whole = source.head.length >= source.totalBytes
  if (source.totalBytes <= limit && whole) return text(redactPieces(decoder.decode(source.head.subarray(0, source.totalBytes)), secrets))
  const half = Math.floor(limit / 2)
  const head = redactPieces(decoder.decode(whole ? source.head.subarray(0, source.totalBytes) : source.head), secrets)
  const tail = whole ? head : redactPieces(decoder.decode(source.tail), secrets)
  const headBytes = encoder.encode(text(head))
  const tailBytes = whole ? headBytes : encoder.encode(text(tail))
  let headEnd = Math.min(headBytes.length, half)
  while (headEnd > 0 && isContinuation(headBytes[headEnd])) headEnd -= 1
  headEnd = markerAround(headBytes, headEnd)?.start ?? headEnd
  // From one text (all of the output was kept), the two ends must not overlap.
  let tailStart = Math.max(whole ? headEnd : 0, tailBytes.length - half)
  while (tailStart < tailBytes.length && isContinuation(tailBytes[tailStart])) tailStart += 1
  tailStart = markerAround(tailBytes, tailStart)?.end ?? tailStart
  const omitted = source.totalBytes - printedBytes(head, headEnd) - printedBytes([...tail].reverse(), tailBytes.length - tailStart)
  return `${decoder.decode(headBytes.subarray(0, headEnd))}\n[… ${Math.max(0, omitted)} bytes left out …]\n${decoder.decode(tailBytes.subarray(tailStart))}`
}

function text(pieces: readonly RedactedPiece[]): string {
  return pieces.map((piece) => piece.text).join("")
}

/** How many bytes of the output as printed the first `shownBytes` bytes of the redacted pieces stand for. */
function printedBytes(pieces: readonly RedactedPiece[], shownBytes: number): number {
  let redacted = 0
  let printed = 0
  for (const piece of pieces) {
    const length = encoder.encode(piece.text).length
    if (redacted + length > shownBytes) return printed + (piece.kind === null ? shownBytes - redacted : 0)
    redacted += length
    printed += encoder.encode(piece.original).length
  }
  return printed
}

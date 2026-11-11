/**
 * shell: runs a command in its own process group. stdout and stderr are read
 * as they arrive, written to a spill file (up to a size limit) and kept in
 * memory only as a bounded head and tail, so a command that prints gigabytes
 * cannot exhaust memory. The tool caps its own output and sets `truncation`,
 * so the runtime never caps it again.
 *
 * Stopping (abort, timeout, or leftovers after the command exits): SIGTERM to
 * the whole group, wait up to the grace period for the group to empty, then
 * SIGKILL the group. Background processes the command started are stopped the
 * same way when it finishes.
 */
import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { interruptReasonOf } from "../interrupt.ts"
import { OUTPUT_LIMITS, type OutputLimits, fitsLimits, renderCapped } from "../tool/cap.ts"
import type { Tool, ToolContext, ToolResult } from "../tool/tool.ts"
import type { ToolOptions } from "./common.ts"

export interface ShellInput {
  readonly command: string
  readonly timeout?: number
}

export interface ShellOptions extends ToolOptions {
  /** The shell to run `-c` with. Default: `bash` from PATH, else `/bin/sh`. */
  readonly shell?: string
  /** Time between SIGTERM and SIGKILL. Default 3000 ms. */
  readonly graceMs?: number
  /** The spill file stops growing at this size; the head and tail in memory still see everything. Default 1 GiB. */
  readonly spillLimitBytes?: number
}

export const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 3600
/** Each is more than half the byte limit, which is what `renderCapped` needs from a streaming source. */
const HEAD_KEEP = 64 * 1024
const TAIL_KEEP = 64 * 1024
const PROGRESS_INTERVAL_MS = 200
const PROGRESS_LINES = 20
/** How long to wait for the pipes to close after the process group is gone (a process that left the group may hold them). */
const DRAIN_MS = 1000
/** The output keeps room for the status line, so the whole result stays within the runtime's limits. */
const BODY_LIMITS: OutputLimits = { maxBytes: OUTPUT_LIMITS.maxBytes - 512, maxLines: OUTPUT_LIMITS.maxLines - 3 }

type StopReason = "timeout" | "user" | "shutdown"

export function shellTool(options: ShellOptions): Tool<ShellInput> {
  const shell = options.shell ?? Bun.which("bash") ?? "/bin/sh"
  const graceMs = options.graceMs ?? 3000
  const spillLimit = options.spillLimitBytes ?? 1024 * 1024 * 1024
  return {
    name: "shell",
    description:
      "Run a shell command in the working directory and return its combined stdout and stderr. stdin is empty. The command is stopped after `timeout` seconds (default 120). Background processes it starts are stopped when it finishes. Long output keeps its beginning and end, and the full output is saved to a file whose path is given.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "The command line, run with `-c`." },
        timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Seconds before the command is stopped. Default 120." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "exec",
    execute: (input, context) => runShell(input, context, { shell, graceMs, spillLimit, spillDir: options.spillDir }),
  }
}

async function runShell(
  input: ShellInput,
  context: ToolContext,
  options: { shell: string; graceMs: number; spillLimit: number; spillDir: string },
): Promise<ToolResult> {
  const startedAt = performance.now()
  const timeoutSeconds = input.timeout ?? DEFAULT_TIMEOUT_SECONDS
  const early = interruptReasonOf(context.signal)
  if (early !== null) return finish({ buffer: null, stopReason: early, exitCode: null, signalCode: null, timeoutSeconds, startedAt, spill: null })

  await mkdir(options.spillDir, { recursive: true })
  const spillPath = join(options.spillDir, `shell-${safeName(context.messageId)}-${safeName(context.callId)}.log`)
  const buffer = createOutputBuffer(Bun.file(spillPath).writer(), options.spillLimit, context)

  const spawned = spawn(options.shell, input.command, context.cwd)
  if (spawned instanceof Error) {
    await buffer.close()
    await unlink(spillPath).catch(() => {})
    return {
      status: "error",
      output: `Could not start the command: ${spawned.message}`,
      truncation: null,
      attachments: [],
      display: { exitCode: null, signal: null, timedOut: false, interrupted: null },
    }
  }
  const child = spawned
  const group = createGroup(child.pid, options.graceMs)

  let stopReason: StopReason | null = null
  const stop = (reason: StopReason) => {
    stopReason ??= reason
    void group.terminate()
  }
  const onAbort = () => stop(interruptReasonOf(context.signal) ?? "user")
  context.signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000)

  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const pumps = Promise.all(
    readers.map(async (reader) => {
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) return
        buffer.append(next.value)
      }
    }),
  )

  const exitCode = await child.exited
  clearTimeout(timer)
  context.signal.removeEventListener("abort", onAbort)
  // Whatever is left of the group (background jobs, a grandchild that ignored SIGTERM) is stopped now.
  await group.terminate()
  const drained = await Promise.race([pumps.then(() => true), Bun.sleep(DRAIN_MS).then(() => false)])
  if (!drained) await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})))
  await buffer.close()

  return finish({
    buffer,
    stopReason,
    exitCode: child.signalCode === null ? exitCode : null,
    signalCode: child.signalCode === null ? null : String(child.signalCode),
    timeoutSeconds,
    startedAt,
    spill: { path: spillPath, limit: options.spillLimit },
  })
}

function spawn(shell: string, command: string, cwd: string) {
  try {
    return Bun.spawn([shell, "-c", command], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    })
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** The process group led by `pid`. `terminate` is idempotent: later calls wait for the first. */
function createGroup(pid: number, graceMs: number) {
  let terminating: Promise<void> | null = null
  const send = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }
  const alive = () => send(0)
  return {
    terminate: () => {
      terminating ??= (async () => {
        if (!send("SIGTERM")) return
        const deadline = performance.now() + graceMs
        while (performance.now() < deadline) {
          await Bun.sleep(25)
          if (!alive()) return
        }
        send("SIGKILL")
      })()
      return terminating
    },
  }
}

type OutputBuffer = ReturnType<typeof createOutputBuffer>

/** Spills every byte (up to the limit) and keeps the first and last bytes, the byte counts and the line count. */
function createOutputBuffer(sink: Bun.FileSink, spillLimit: number, context: ToolContext) {
  const head = new Uint8Array(HEAD_KEEP)
  let headLength = 0
  // A ring one byte longer than the tail, so the byte before the tail is known (is the tail at a line start?).
  const ring = new Uint8Array(TAIL_KEEP + 1)
  let ringEnd = 0
  let total = 0
  let newlines = 0
  let lastByte = -1
  let spilled = 0
  let lastProgress = 0
  let closed = false

  const tailBytes = (keep: number) => {
    const length = Math.min(total, keep)
    const out = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) out[index] = ring[(ringEnd - length + index + ring.length * 2) % ring.length]!
    return out
  }

  return {
    append(chunk: Uint8Array) {
      if (closed || chunk.length === 0) return
      if (spilled < spillLimit) {
        const part = chunk.subarray(0, spillLimit - spilled)
        sink.write(part)
        spilled += part.length
      }
      if (headLength < HEAD_KEEP) {
        const part = chunk.subarray(0, HEAD_KEEP - headLength)
        head.set(part, headLength)
        headLength += part.length
      }
      const recent = chunk.length > ring.length ? chunk.subarray(chunk.length - ring.length) : chunk
      for (let offset = 0; offset < recent.length; ) {
        const room = Math.min(ring.length - ringEnd, recent.length - offset)
        ring.set(recent.subarray(offset, offset + room), ringEnd)
        ringEnd = (ringEnd + room) % ring.length
        offset += room
      }
      for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) newlines += 1
      total += chunk.length
      lastByte = chunk[chunk.length - 1]!
      const now = performance.now()
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now
        context.progress({ text: lastLines(tailBytes(4096), PROGRESS_LINES) })
      }
    },
    async close() {
      closed = true
      await sink.end()
    },
    get totalBytes() {
      return total
    },
    get totalLines() {
      return total > 0 && lastByte !== 0x0a ? newlines + 1 : newlines
    },
    get spilledBytes() {
      return spilled
    },
    head: () => head.subarray(0, headLength),
    /** The last bytes and whether they start a line. */
    tail: () => {
      const withBefore = tailBytes(TAIL_KEEP + 1)
      if (total <= TAIL_KEEP) return { bytes: withBefore, atLineStart: true }
      return { bytes: withBefore.subarray(1), atLineStart: withBefore[0] === 0x0a }
    },
  }
}

const decoder = new TextDecoder()

function lastLines(bytes: Uint8Array, count: number): string {
  let start = 0
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  const lines = decoder.decode(bytes.subarray(start)).split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-count).join("\n")
}

async function finish(run: {
  buffer: OutputBuffer | null
  stopReason: StopReason | null
  exitCode: number | null
  signalCode: string | null
  timeoutSeconds: number
  startedAt: number
  spill: { path: string; limit: number } | null
}): Promise<ToolResult> {
  const buffer = run.buffer
  const capped = buffer !== null && run.spill !== null && !fitsLimits(buffer.totalBytes, buffer.totalLines, BODY_LIMITS)
  const body =
    buffer === null || buffer.totalBytes === 0
      ? ""
      : capped
        ? renderCapped(
            {
              head: buffer.head(),
              tail: buffer.tail().bytes,
              tailAtLineStart: buffer.tail().atLineStart,
              totalBytes: buffer.totalBytes,
              totalLines: buffer.totalLines,
            },
            { path: run.spill!.path, savedBytes: buffer.spilledBytes },
            BODY_LIMITS,
          )
        : decoder.decode(buffer.head())
  if (!capped && run.spill !== null) await unlink(run.spill.path).catch(() => {})
  const status = statusLine(run)
  const text = body === "" ? "(no output)" : body
  const output = status === null ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${status}`
  return {
    status: status === null ? "success" : "error",
    output,
    truncation: capped ? { originalBytes: buffer!.totalBytes, originalLines: buffer!.totalLines, spillPath: run.spill!.path } : null,
    attachments: [],
    display: {
      exitCode: run.exitCode,
      signal: run.signalCode,
      timedOut: run.stopReason === "timeout",
      interrupted: run.stopReason === "user" || run.stopReason === "shutdown" ? run.stopReason : null,
      durationMs: Math.round(performance.now() - run.startedAt),
    },
  }
}

function statusLine(run: { stopReason: StopReason | null; exitCode: number | null; signalCode: string | null; timeoutSeconds: number; buffer: OutputBuffer | null }) {
  const stopped =
    run.buffer === null ? "The command was not started." : "The command and its child processes were stopped; the output above is everything it printed before that."
  switch (run.stopReason) {
    case "timeout":
      return `[Timed out after ${run.timeoutSeconds} ${run.timeoutSeconds === 1 ? "second" : "seconds"}. ${stopped}]`
    case "user":
      return `[Interrupted by the user. ${stopped}]`
    case "shutdown":
      return `[Interrupted because the harness is shutting down. ${stopped}]`
    case null:
      if (run.signalCode !== null) return `[Killed by signal ${run.signalCode}]`
      if (run.exitCode !== 0) return `[Exit code ${run.exitCode}]`
      return null
  }
}

function safeName(id: string) {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_")
}

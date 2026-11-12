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
 * same way when it finishes. If this process dies while a command runs, a
 * guard process kills the command's group (`guardGroup`).
 */
import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { escalationSchema } from "../approval/escalation.ts"
import { interruptReasonOf } from "../interrupt.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import { OUTPUT_LIMITS, type OutputLimits, fitsLimits, renderCapped } from "../tool/cap.ts"
import type { Tool, ToolContext, ToolResult } from "../tool/tool.ts"
import type { ToolOptions } from "./common.ts"

export interface ShellInput {
  readonly command: string
  readonly timeout?: number
  /**
   * The model's explicit request for more access than the sandbox gives. The
   * tool does not act on it: the step loop decides from it (and asks the
   * user), and tells the tool how to run through `ToolContext.sandbox`.
   */
  readonly sandbox?: { readonly network?: boolean; readonly write?: readonly string[] }
}

export interface ShellOptions extends ToolOptions {
  /** The shell to run `-c` with. Default: `bash` from PATH, else `/bin/sh`. */
  readonly shell?: string
  /** Time between SIGTERM and SIGKILL. Default 3000 ms. */
  readonly graceMs?: number
  /** The spill file stops growing at this size; the head and tail in memory still see everything. Default 1 GiB. */
  readonly spillLimitBytes?: number
  /**
   * Wraps a command the step loop decided to run sandboxed. Without it such
   * a command is refused: the tool never runs unsandboxed what it was told
   * to sandbox.
   */
  readonly sandbox?: CommandSandbox
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
const BODY_LIMITS: OutputLimits = { maxBytes: OUTPUT_LIMITS.maxBytes - 1024, maxLines: OUTPUT_LIMITS.maxLines - 6 }

type StopReason = "timeout" | "user" | "shutdown"

export function shellTool(options: ShellOptions): Tool<ShellInput> {
  const shell = options.shell ?? Bun.which("bash") ?? "/bin/sh"
  const graceMs = options.graceMs ?? 3000
  const spillLimit = options.spillLimitBytes ?? 1024 * 1024 * 1024
  return {
    name: "shell",
    description:
      "Run a shell command in the working directory and return its combined stdout and stderr. stdin is empty. The command is stopped after `timeout` seconds (default 120). Background processes it starts are stopped when it finishes. Long output keeps its beginning and end, and the full output is saved to a file whose path is given (read it with the read or grep tool). Commands normally run in a sandbox: no network, and writes only inside the working directory and the temp directory ($TMPDIR, which is /tmp on Linux; it is private to this session and the file tools see the same files there). When a command needs more, pass `sandbox`.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "The command line, run with `-c`." },
        timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Seconds before the command is stopped. Default 120." },
        sandbox: escalationSchema,
      },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "exec",
    execute: (input, context) => runShell(input, context, { shell, graceMs, spillLimit, spillDir: options.spillDir, sandbox: options.sandbox ?? null }),
  }
}

async function runShell(
  input: ShellInput,
  context: ToolContext,
  options: { shell: string; graceMs: number; spillLimit: number; spillDir: string; sandbox: CommandSandbox | null },
): Promise<ToolResult> {
  const startedAt = performance.now()
  const timeoutSeconds = input.timeout ?? DEFAULT_TIMEOUT_SECONDS
  const early = interruptReasonOf(context.signal)
  if (early !== null) return finish({ buffer: null, stopReason: early, exitCode: null, signalCode: null, timeoutSeconds, startedAt, spill: null })

  // Decided before anything is created: a command that must run sandboxed runs sandboxed or not at all.
  const wrapped = context.sandbox === undefined || context.sandbox === null ? null : sandboxed(input.command, context, options)
  if (wrapped !== null && "refused" in wrapped)
    return { status: "error", output: `Could not start the command: ${wrapped.refused}`, truncation: null, attachments: [], display: { exitCode: null, signal: null, timedOut: false, interrupted: null } }

  await mkdir(options.spillDir, { recursive: true })
  const spillPath = join(options.spillDir, `shell-${safeName(context.messageId)}-${safeName(context.callId)}.log`)
  const buffer = createOutputBuffer(Bun.file(spillPath).writer(), options.spillLimit, context)

  const spawned = spawn(wrapped ?? { argv: [options.shell, "-c", input.command], env: process.env, cwd: context.cwd })
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
  const guard = guardGroup(child.pid)

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
  guard.release()
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

/** What to spawn for a command that runs in the sandbox, or why it cannot. */
function sandboxed(command: string, context: ToolContext, options: { shell: string; sandbox: CommandSandbox | null }) {
  if (options.sandbox === null) return { refused: "it must run in the sandbox, and this build has none" }
  const plan = options.sandbox.plan({ sessionId: context.sessionId, cwd: context.cwd, run: context.sandbox!, command, shellPath: options.shell })
  if (plan.kind !== "ready") return { refused: `it must run in the sandbox, which is unavailable: ${plan.reason}` }
  return { argv: plan.argv, env: plan.env, cwd: plan.cwd }
}

function spawn(plan: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }) {
  try {
    return Bun.spawn([...plan.argv], {
      cwd: plan.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group. The sandbox wrapper relies on it too: the kill sequence below reaches everything inside.
      detached: true,
      env: { ...plan.env, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
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

/**
 * Makes sure the group led by `pid` does not outlive this process, however
 * the process ends (a crash, SIGKILL, a second Ctrl-C). The command runs in
 * its own process group, so nothing the operating system does to this
 * process reaches it; while this process lives, `createGroup` stops it.
 *
 * The guard is a small shell process in a session of its own that blocks
 * reading a pipe only this process holds the other end of. When this process
 * dies, for any reason, the pipe closes, the read returns and the guard kills
 * the group. `release` ends the guard once the command is over.
 * It is best effort: if the guard cannot be started the command still runs.
 */
function guardGroup(pid: number): { release: () => void } {
  try {
    // `kill -s KILL -- -<pgid>` is the form every POSIX shell accepts for a process group (dash rejects `-KILL -- -<pgid>`).
    const guard = Bun.spawn(["/bin/sh", "-c", 'read -r _; kill -s KILL -- "-$1" 2>/dev/null', "guard", String(pid)], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    guard.unref()
    return {
      release: () => {
        try {
          guard.kill("SIGKILL")
        } catch {
          // Already gone.
        }
      },
    }
  } catch {
    return { release: () => {} }
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

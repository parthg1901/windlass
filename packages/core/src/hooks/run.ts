/**
 * Running a hook's command. The only part of the module that starts processes; everything it returns is a
 * `HookProcessResult`, which `answer.ts` turns into an answer.
 *
 * It goes through the checks' runner (`../verify/run.ts`, i.e. the shell tool), as the wake-up checks do: its own
 * process group, the timeout with SIGTERM then SIGKILL to the group, a guard that kills the group if this process
 * dies, and the output kept as a bounded head and tail however much is printed. A hook planned to run in the
 * sandbox runs there with exactly that access, or not at all.
 *
 * The command is wrapped so that it gets the event on stdin and its stdout can be told from its stderr (the
 * shell tool interleaves them):
 *
 *   export <P>_HOOK_POINT='beforeTool' ...            the environment, single-quoted
 *   __hook_out="${TMPDIR:-/tmp}/<P>-hook-stdout-$$"
 *   (
 *   <the hook's command>
 *   ) <<'<P>_HOOK_EVENT_<nonce>' >"$__hook_out"      a subshell, so an `exit` in the command ends only it
 *   <the event JSON, one line>
 *   <P>_HOOK_EVENT_<nonce>
 *   __hook_status=$?
 *   printf '\n%s %s\n' '<marker>' "$(wc -c <"$__hook_out")"   then the first bytes of stdout
 *
 * The marker line says the command ran to its end and how much it printed on stdout. A run that exited without
 * it (a syntax error in the command, which bash reports with exit 2) is `could_not_start`, never an answer.
 */
import { rm } from "node:fs/promises"
import { redact } from "../approval/redact.ts"
import { createInterrupt, interruptReasonOf } from "../interrupt.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import type { SandboxRun } from "../tool/tool.ts"
import { runCheck } from "../verify/run.ts"
import type { HookProcessResult } from "./answer.ts"
import type { Hook } from "./config.ts"
import { HOOK_ENV_PREFIX, type HookEvent } from "./event.ts"

export interface HookRunRequest {
  readonly hook: Hook
  readonly event: HookEvent
  readonly cwd: string
  readonly sessionId: string
  /** From `planHookRun`: `null` runs it unsandboxed. */
  readonly sandbox: SandboxRun | null
  /** The execution's interrupt signal. */
  readonly signal: AbortSignal
}

export type HookRunner = (request: HookRunRequest) => Promise<HookProcessResult>

export interface HookRunnerOptions {
  /** Where the output is written while a hook runs; each file is deleted afterwards. */
  readonly spillDir: string
  /** Required to run a hook planned in the sandbox. */
  readonly sandbox?: CommandSandbox
  readonly shell?: string
  readonly graceMs?: number
  /** Values to redact wherever they occur (the engine's `secrets`). */
  readonly secrets?: () => readonly string[]
}

/** How much of stdout is read back. More than any answer limit, so a long answer is known to be long. */
export const STDOUT_READ_BYTES = 16 * 1024
/** How much of stderr is kept for the user. */
export const STDERR_KEPT_CHARS = 2048

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function createHookRunner(options: HookRunnerOptions): HookRunner {
  return async (request) => {
    if (interruptReasonOf(request.signal) !== null || request.signal.aborted) return { kind: "interrupted" }
    if (request.sandbox !== null && (options.sandbox === undefined || !options.sandbox.state.available)) {
      const why = options.sandbox === undefined || options.sandbox.state.available ? "this harness was given none" : options.sandbox.state.reason
      return { kind: "cannot_run", message: `it must run in the sandbox, which is unavailable: ${why}` }
    }
    const nonce = crypto.randomUUID().replaceAll("-", "")
    const marker = `${HOOK_ENV_PREFIX}ANSWER_${nonce}`
    const command = wrap(request.hook.command, request.event, nonce, marker)
    // The checks' runner takes an interrupt token: forward the execution's signal, keeping its reason.
    const interrupt = createInterrupt()
    const forward = () => interrupt.interrupt(interruptReasonOf(request.signal) ?? "user")
    request.signal.addEventListener("abort", forward, { once: true })
    const secrets = options.secrets?.() ?? []
    try {
      const result = await runCheck(
        { name: `hook-${request.hook.id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${nonce.slice(0, 8)}`, command, timeoutSeconds: request.hook.timeoutSeconds, when: null },
        {
          cwd: request.cwd,
          spillDir: options.spillDir,
          signal: interrupt.signal,
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
          spillLimitBytes: 4 * 1024 * 1024,
          ...(request.sandbox === null ? {} : { sandbox: { sandbox: options.sandbox!, run: request.sandbox, sessionId: request.sessionId } }),
        },
      )
      if (result.output.path !== null) await rm(result.output.path, { force: true })
      const text = decoder.decode(result.output.source.tail)
      const at = text.lastIndexOf(`\n${marker} `)
      const before = at === -1 ? text : text.slice(0, at)
      const stderr = redact(before.length > STDERR_KEPT_CHARS ? before.slice(-STDERR_KEPT_CHARS) : before, secrets).text.trim()
      switch (result.status) {
        case "interrupted":
          return { kind: "interrupted" }
        case "timed_out":
          return { kind: "timed_out", timeoutSeconds: request.hook.timeoutSeconds, stderr, durationMs: result.durationMs }
        case "could_not_start":
          return { kind: "could_not_start", message: result.startError ?? `the shell could not run it (exit ${result.exitCode ?? "unknown"})${stderr === "" ? "" : `: ${firstLine(stderr)}`}` }
        case "passed":
        case "failed": {
          if (result.exitCode === null) return { kind: "killed", signal: result.signal ?? "unknown", stderr, durationMs: result.durationMs }
          if (at === -1)
            return { kind: "could_not_start", message: `the command did not run to its end (exit ${result.exitCode}; a syntax error?)${stderr === "" ? "" : `: ${firstLine(stderr)}`}` }
          const rest = text.slice(at + marker.length + 2)
          const newline = rest.indexOf("\n")
          const stdoutBytes = Number.parseInt(rest.slice(0, newline), 10)
          // The checks' runner takes off the status line the shell tool appends (`[Exit code 2]`), but leaves the
          // newline put before it; what was read is at most the bytes the hook printed, up to the read limit.
          const readBytes = Number.isFinite(stdoutBytes) ? Math.min(stdoutBytes, STDOUT_READ_BYTES) : STDOUT_READ_BYTES
          const bytes = encoder.encode(rest.slice(newline + 1))
          // `stream: true` holds back a character the read limit cut in two instead of decoding it as U+FFFD.
          const stdout = new TextDecoder().decode(bytes.subarray(0, readBytes), { stream: true })
          return {
            kind: "exited",
            exitCode: result.exitCode,
            stdout: redact(stdout, secrets).text,
            stdoutBytes: Number.isFinite(stdoutBytes) ? stdoutBytes : 0,
            stderr,
            durationMs: result.durationMs,
          }
        }
      }
    } finally {
      request.signal.removeEventListener("abort", forward)
    }
  }
}

/** The shell script that runs a hook's command with its event. Exported for tests. */
export function wrap(command: string, event: HookEvent, nonce: string, marker: string): string {
  const delimiter = `${HOOK_ENV_PREFIX}EVENT_${nonce}`
  const exports = Object.entries(event.env).map(([name, value]) => `export ${name}=${quote(value)}`)
  return [
    ...exports,
    `__hook_out="\${TMPDIR:-/tmp}/${HOOK_ENV_PREFIX.toLowerCase()}stdout-$$-${nonce.slice(0, 8)}"`,
    "(",
    command,
    `) <<'${delimiter}' >"$__hook_out"`,
    event.stdin,
    delimiter,
    "__hook_status=$?",
    `printf '\\n%s %s\\n' '${marker}' "$(wc -c <"$__hook_out" | tr -d ' ')"`,
    `head -c ${STDOUT_READ_BYTES} "$__hook_out"`,
    `rm -f "$__hook_out"`,
    `exit "$__hook_status"`,
    "",
  ].join("\n")
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? ""
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

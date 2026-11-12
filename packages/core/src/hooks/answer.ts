/**
 * How a hook answers, and the parser from what its process did to that answer. Pure.
 *
 * The format, the same at every point:
 *
 * | The process | The answer |
 * | --- | --- |
 * | exits 0 | `yes`: no objection, nothing to add. Its stdout is not shown to the model (it is kept for the user). |
 * | exits 2 | `no`: the hook has something for the model. Its stdout, trimmed, is the text: the reason a call is refused, the note added to a result, the message a stop hook sends back. Empty stdout: a default text. |
 * | exits 2 with stdout that is not text (a NUL byte, invalid UTF-8, other control characters) | `failed`, `garbage` |
 * | exits with any other code | `failed`, `error_exit` (a script that broke usually exits 1) |
 * | is killed by a signal | `failed`, `killed` |
 * | runs past its timeout | `failed`, `timed_out` (its process group is killed) |
 * | cannot be started (no shell, exit 126 or 127) | `failed`, `could_not_start` |
 * | must run in the sandbox and there is none | `failed`, `cannot_run` |
 *
 * stderr is never shown to the model; it is for the user. A `no` text longer than the point's limit is cut and
 * says so; it is the hook's own text, never the tool's.
 */

/** What the runner observed. `stdout` and `stderr` are decoded, redacted and bounded by the runner. */
export type HookProcessResult =
  | { readonly kind: "exited"; readonly exitCode: number; readonly stdout: string; readonly stdoutBytes: number; readonly stderr: string; readonly durationMs: number }
  | { readonly kind: "killed"; readonly signal: string; readonly stderr: string; readonly durationMs: number }
  | { readonly kind: "timed_out"; readonly timeoutSeconds: number; readonly stderr: string; readonly durationMs: number }
  | { readonly kind: "could_not_start"; readonly message: string }
  | { readonly kind: "cannot_run"; readonly message: string }
  /** Stopped by an interrupt of the execution. */
  | { readonly kind: "interrupted" }

export type HookFailure = "timed_out" | "error_exit" | "killed" | "could_not_start" | "garbage" | "cannot_run"

export type HookAnswer =
  | { readonly kind: "yes" }
  /** `text` is trimmed and at most the point's limit; `cut` says whether it was longer. */
  | { readonly kind: "no"; readonly text: string; readonly cut: boolean }
  | { readonly kind: "failed"; readonly failure: HookFailure; readonly detail: string }
  | { readonly kind: "interrupted" }

/** The exit code that means "no" (refuse, note, send back). */
export const NO_EXIT_CODE = 2

/** The longest text the model is shown from one hook. */
export const ANSWER_LIMITS = { beforeTool: 2000, afterTool: 2000, stop: 4000 } as const

export function parseAnswer(result: HookProcessResult, limit: number): HookAnswer {
  switch (result.kind) {
    case "interrupted":
      return { kind: "interrupted" }
    case "cannot_run":
      return { kind: "failed", failure: "cannot_run", detail: result.message }
    case "could_not_start":
      return { kind: "failed", failure: "could_not_start", detail: result.message }
    case "timed_out":
      return { kind: "failed", failure: "timed_out", detail: `it did not answer within ${result.timeoutSeconds} ${result.timeoutSeconds === 1 ? "second" : "seconds"}` }
    case "killed":
      return { kind: "failed", failure: "killed", detail: `it was killed by signal ${result.signal}` }
    case "exited": {
      if (result.exitCode === 0) return { kind: "yes" }
      if (result.exitCode === 126 || result.exitCode === 127) return { kind: "failed", failure: "could_not_start", detail: `the shell could not run it (exit ${result.exitCode})` }
      if (result.exitCode !== NO_EXIT_CODE) return { kind: "failed", failure: "error_exit", detail: `it exited with code ${result.exitCode}; a hook answers with 0 or ${NO_EXIT_CODE}` }
      const problem = notText(result.stdout)
      if (problem !== null) return { kind: "failed", failure: "garbage", detail: `its answer is not text (${problem})` }
      const text = result.stdout.trim()
      const cut = text.length > limit || result.stdoutBytes > new TextEncoder().encode(result.stdout).length
      return { kind: "no", text: cut ? cutText(text, limit) : text, cut }
    }
  }
}

/** Why a string is not something to show the model as text, or `null` when it is fine. */
export function notText(text: string): string | null {
  if (text.includes("\0")) return "it contains a NUL byte"
  if (text.includes("�")) return "it is not valid UTF-8"
  // Tabs, newlines and carriage returns are text; other C0 controls and DEL are not (escape sequences, binary).
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return "it contains control characters"
  return null
}

function cutText(text: string, limit: number): string {
  const marker = " […the hook's answer was cut]"
  let end = Math.max(0, limit - marker.length)
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end).trimEnd()}${marker}`
}

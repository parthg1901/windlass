/**
 * Runs one program in a process of its own and carries its tool calls to
 * the harness. The process is meant to run confined (`CommandSandbox.confined`:
 * nothing writable but its own directory, no network), so that the program
 * can touch nothing itself: every effect is a call it sends here, and the
 * host makes each one a tool call of the session's.
 *
 * What it guarantees:
 * - Every call the program makes reaches `host.call` once, or is answered
 *   without reaching it (a tool the program may not call, a call past the
 *   limit, a call after the program was stopped). Calls run as the program
 *   makes them: several at once when it does not wait for one before the next.
 * - It resolves only when every call that reached the host has its result,
 *   whatever ended the program: the host's calls are never left running.
 * - Limits: the number of calls, the program's own running time (time while
 *   at least one call is out is not counted: a call has its own limits, and
 *   a question to the user may take long), the memory of its process tree
 *   (Linux), and how much printed text is kept.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { PRELUDE, programModule } from "./prelude.ts"

/** The result of one call, as the program's function resolves or rejects with it. */
export interface ProgramCallResult {
  readonly status: "success" | "error" | "not_started" | "effect_unknown"
  readonly output: string
}

/** Who carries out the program's calls: the step loop, for a session. */
export interface ProgramHost {
  /** One call of the program. `argumentsText` is the arguments as JSON text, an object. Must not reject. */
  readonly call: (name: string, argumentsText: string) => Promise<ProgramCallResult>
}

export interface ProgramLimits {
  /** Calls a program may make. The next one is answered as not run. */
  readonly calls: number
  /** The program's own running time, in milliseconds, not counting the time while a call is out. */
  readonly ownTimeMs: number
  /** Memory of the program's process tree, in bytes (Linux; elsewhere not measured). */
  readonly memoryBytes: number
  /** Printed text kept, in bytes; the rest is counted and dropped. */
  readonly printBytes: number
}

export const PROGRAM_LIMITS: ProgramLimits = { calls: 50, ownTimeMs: 60_000, memoryBytes: 512 * 1024 * 1024, printBytes: 1024 * 1024 }

/** What to spawn, as `confine` plans it: the process sees its directory as `root` (`/tmp` under bubblewrap). */
export interface ProgramPlan {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export type Confine = (input: { readonly root: string; readonly argv: (root: string) => readonly string[]; readonly env: Readonly<Record<string, string>> }) => ProgramPlan | { readonly refused: string }

export interface RunProgramOptions {
  readonly source: string
  /** The functions the program is given, by tool name. */
  readonly tools: readonly string[]
  readonly host: ProgramHost
  /** The call's own signal: the program is ended when it fires. */
  readonly signal: AbortSignal
  /** A directory for this run, made here and removed afterwards. */
  readonly dir: string
  /** How the process is confined; `null` runs it as it is (no sandbox: tests, or the mode the user chose). */
  readonly confine: Confine | null
  readonly limits?: Partial<ProgramLimits>
  /** The Bun that runs the program. Default: this process's own (a compiled harness runs as Bun with `BUN_BE_BUN`). */
  readonly bun?: string
}

export type ProgramError = {
  /** `syntax`: it did not parse, nothing ran. `tool`: a call failed and the program did not catch it. `runtime`: anything else it threw. */
  readonly kind: "syntax" | "tool" | "runtime"
  readonly name: string
  readonly message: string
  /** The program's own line and column, when the error says where. */
  readonly line: number | null
  readonly column: number | null
  /** For `tool`: which tool, and how its call ended. */
  readonly tool?: string | null
  readonly status?: string | null
}

export type ProgramEnd =
  | { readonly kind: "returned"; readonly value: string | null }
  | { readonly kind: "threw"; readonly error: ProgramError }
  | { readonly kind: "limit"; readonly limit: "time" | "memory" }
  /** The call's signal fired: `reason` is the signal's reason, read by the caller. */
  | { readonly kind: "stopped" }
  /** The process could not be started, or ended without saying how. */
  | { readonly kind: "failed"; readonly reason: string }

export interface ProgramOutcome {
  readonly end: ProgramEnd
  /** What the program printed, as far as it was kept. */
  readonly printed: string
  /** Bytes printed beyond `printBytes`, dropped. */
  readonly droppedBytes: number
  /** Calls that reached the host. */
  readonly calls: number
  /** Calls answered without reaching the host: past the limit, or of a tool the program is not given. */
  readonly refusedCalls: number
  readonly durationMs: number
}

const BUN_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"] as const

export async function runProgram(options: RunProgramOptions): Promise<ProgramOutcome> {
  const limits = { ...PROGRAM_LIMITS, ...options.limits }
  const startedAt = performance.now()
  const nonce = randomBytes(12).toString("hex")
  mkdirSync(options.dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(options.dir, "prelude.mjs"), PRELUDE)
  writeFileSync(join(options.dir, "program.mjs"), programModule(options.source))
  const bun = options.bun ?? process.execPath
  const argv = (root: string) => [bun, "--no-install", join(root, "prelude.mjs"), nonce, join(root, "program.mjs"), JSON.stringify(options.tools)]
  const env: Record<string, string> = { BUN_BE_BUN: "1", NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
  for (const name of BUN_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]!
  const planned: ProgramPlan | { readonly refused: string } = options.confine === null ? { argv: argv(options.dir), env, cwd: options.dir } : options.confine({ root: options.dir, argv, env })

  const printed: string[] = []
  let keptBytes = 0
  let droppedBytes = 0
  const keep = (text: string) => {
    const bytes = Buffer.byteLength(text)
    if (keptBytes + bytes <= limits.printBytes) {
      printed.push(text)
      keptBytes += bytes
    } else droppedBytes += bytes
  }
  let calls = 0
  let refusedCalls = 0
  const outcome = (end: ProgramEnd): ProgramOutcome => ({ end, printed: printed.join(""), droppedBytes, calls, refusedCalls, durationMs: Math.round(performance.now() - startedAt) })
  const cleanup = () => rmSync(options.dir, { recursive: true, force: true })

  if ("refused" in planned) {
    cleanup()
    return outcome({ kind: "failed", reason: planned.refused })
  }
  if (options.signal.aborted) {
    cleanup()
    return outcome({ kind: "stopped" })
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    child = Bun.spawn([...planned.argv], { cwd: planned.cwd, env: planned.env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true })
  } catch (error) {
    cleanup()
    return outcome({ kind: "failed", reason: `the program's process could not be started: ${error instanceof Error ? error.message : String(error)}` })
  }

  let end: ProgramEnd | null = null
  let ended: () => void = () => {}
  const over = new Promise<void>((resolve) => (ended = resolve))
  const stop = (why: ProgramEnd) => {
    if (end !== null) return
    end = why
    killGroup(child.pid)
    ended()
  }

  // The calls that reached the host and have no result yet. The program's own time does not run while one is out.
  const out = new Set<Promise<void>>()
  const answer = (id: unknown, result: ProgramCallResult) => {
    if (end !== null) return
    try {
      child.stdin.write(`${JSON.stringify({ id, status: result.status, output: result.output })}\n`)
      child.stdin.flush()
    } catch {
      // The process is gone; its end is reported by itself.
    }
  }
  const take = (message: Record<string, unknown>) => {
    switch (message.type) {
      case "print":
        if (typeof message.text === "string") keep(message.text)
        return
      case "call": {
        const name = String(message.name)
        const input = typeof message.input === "string" ? message.input : "{}"
        if (end !== null) return
        if (!options.tools.includes(name)) {
          refusedCalls += 1
          return answer(message.id, { status: "not_started", output: `Not run: a program cannot call ${name}. It can call ${options.tools.join(", ")}.` })
        }
        if (calls >= limits.calls) {
          refusedCalls += 1
          return answer(message.id, { status: "not_started", output: `Not run: a program makes at most ${limits.calls} tool calls, and this one made that many already. Do the rest in another program or with direct calls.` })
        }
        calls += 1
        const work: Promise<void> = options.host
          .call(name, input)
          .catch((error: unknown): ProgramCallResult => ({ status: "error", output: `The call could not be made: ${error instanceof Error ? error.message : String(error)}` }))
          .then((result) => answer(message.id, result))
          .finally(() => out.delete(work))
        out.add(work)
        return
      }
      case "return":
        return stop({ kind: "returned", value: typeof message.value === "string" ? message.value : null })
      case "error":
        return stop({ kind: "threw", error: programError(message.error) })
    }
  }

  const stdout = (async () => {
    const decoder = new TextDecoder()
    let pending = ""
    const prefix = `${nonce} `
    const line = (text: string) => {
      if (!text.startsWith(prefix)) return keep(`${text}\n`)
      try {
        const message = JSON.parse(text.slice(prefix.length)) as unknown
        if (typeof message === "object" && message !== null) take(message as Record<string, unknown>)
      } catch {
        keep(`${text}\n`)
      }
    }
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
        line(pending.slice(0, at))
        pending = pending.slice(at + 1)
      }
    }
    if (pending !== "") line(pending)
  })().catch(() => {})
  const stderrParts: string[] = []
  const stderr = (async () => {
    const decoder = new TextDecoder()
    let size = 0
    for await (const chunk of child.stderr) {
      if (size > 16_384) continue
      const text = decoder.decode(chunk, { stream: true })
      size += text.length
      stderrParts.push(text)
    }
  })().catch(() => {})

  // The program's own time, and its memory, looked at a few times a second.
  let ownMs = 0
  let last = performance.now()
  const watch = setInterval(() => {
    const now = performance.now()
    if (out.size === 0) ownMs += now - last
    last = now
    if (ownMs > limits.ownTimeMs) return stop({ kind: "limit", limit: "time" })
    const memory = treeMemory(child.pid)
    if (memory !== null && memory > limits.memoryBytes) stop({ kind: "limit", limit: "memory" })
  }, 100)
  const onAbort = () => stop({ kind: "stopped" })
  options.signal.addEventListener("abort", onAbort, { once: true })
  const guard = guardGroup(child.pid)

  await Promise.race([over, child.exited])
  // The process said how it ended (or was ended): what it printed before that is still in the pipe.
  await Promise.race([stdout, Bun.sleep(1000)])
  if (end === null) {
    // It ended without a word: a crash of the process, or a kill from outside.
    await Promise.race([stderr, Bun.sleep(200)])
    const said = stderrParts.join("").trim()
    const code = child.exitCode
    stop({ kind: "failed", reason: `the program's process ended without finishing${code === null ? "" : ` (exit code ${code})`}${said === "" ? "" : `: ${said.slice(-2000)}`}` })
  }
  killGroup(child.pid)
  clearInterval(watch)
  options.signal.removeEventListener("abort", onAbort)
  // Every call that reached the host has its result before this returns, whatever ended the program.
  while (out.size > 0) await Promise.all([...out])
  guard.release()
  try {
    child.stdin.end()
  } catch {
    // Already closed.
  }
  cleanup()
  return outcome(end!)
}

function programError(value: unknown): ProgramError {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const kind = record.kind === "syntax" || record.kind === "tool" ? record.kind : "runtime"
  const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field >= 1 ? field : null)
  return {
    kind,
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : "the program failed",
    line: number(record.line),
    column: number(record.column),
    tool: typeof record.tool === "string" ? record.tool : null,
    status: typeof record.status === "string" ? record.status : null,
  }
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // Gone already.
  }
}

/** The resident memory of `pid` and everything below it, in bytes; `null` where `/proc` cannot tell. */
function treeMemory(pid: number): number | null {
  if (process.platform !== "linux") return null
  let total = 0
  const seen = new Set<number>()
  const visit = (id: number, depth: number) => {
    if (seen.has(id) || depth > 16) return
    seen.add(id)
    try {
      const status = readFileSync(`/proc/${id}/status`, "utf8")
      const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
      if (rss !== null) total += Number(rss[1]) * 1024
      for (const task of readdirSync(`/proc/${id}/task`)) {
        const children = readFileSync(`/proc/${id}/task/${task}/children`, "utf8").trim()
        for (const child of children === "" ? [] : children.split(/\s+/)) visit(Number(child), depth + 1)
      }
    } catch {
      // Gone, or not ours to read.
    }
  }
  visit(pid, 0)
  return seen.size === 0 ? null : total
}

/**
 * Makes sure the program's process group does not outlive the harness,
 * however the harness ends: a shell in a session of its own waits on a pipe
 * only this process holds, and kills the group when it closes. As the
 * shell tool does for a command (`tools/shell.ts`). Best effort.
 */
function guardGroup(pid: number): { release: () => void } {
  try {
    const guard = Bun.spawn(["/bin/sh", "-c", 'read -r _; kill -s KILL -- "-$1" 2>/dev/null', "guard", String(pid)], { stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true })
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

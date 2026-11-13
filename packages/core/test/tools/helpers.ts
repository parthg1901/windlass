/** Shared test helpers for the tools: real temporary directories, a real context, a real runtime. */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { type ToolCallOutcome, createToolRuntime } from "../../src/tool/runtime.ts"
import { type AnyTool, type ToolContext, type ToolProgress, noBlobStore } from "../../src/tool/tool.ts"
import { type StandardToolOptions, createStandardTools } from "../../src/tools/index.ts"

const created: string[] = []

/** A fresh temporary directory, removed after the test. Its path has symlinks resolved (macOS /var -> /private/var). */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-tools-"))
  created.push(dir)
  return realpathSync(dir)
}

/** Removes every directory `tempDir` made. Each test file registers it with `afterEach(removeTempDirs)`. */
export function removeTempDirs() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

let calls = 0

export function context(cwd: string, options: { signal?: AbortSignal; progress?: ToolProgress[] } = {}): ToolContext {
  calls += 1
  return {
    sessionId: "ses_test" as SessionId,
    messageId: "msg_test" as MessageId,
    callId: `call_${calls}` as CallId,
    cwd,
    signal: options.signal ?? createInterrupt().signal,
    progress: (update) => options.progress?.push(update),
    // None of the standard tools returns media yet.
    putBlob: noBlobStore,
  }
}

/** A workspace with the standard tools and a runtime, the way the step loop will use them. */
export function workspace(options: Partial<StandardToolOptions> = {}) {
  const root = tempDir()
  const spillDir = join(tempDir(), "spill")
  const tools = createStandardTools({ spillDir, ...options })
  const runtime = createToolRuntime({ tools, spillDir, putBlob: noBlobStore })
  return {
    root,
    spillDir,
    tools,
    runtime,
    path: (name: string) => join(root, name),
    write: (name: string, content: string | Uint8Array) => Bun.write(join(root, name), content),
    read: (name: string) => readFileSync(join(root, name), "utf8"),
    /** Calls a tool through the runtime with arguments as the model would send them. */
    call: (name: string, args: unknown, extra: { signal?: AbortSignal; progress?: ToolProgress[] } = {}) =>
      runtime.run({ name, argumentsText: typeof args === "string" ? args : JSON.stringify(args), context: context(root, extra) }),
  }
}

export function toolNamed(tools: readonly AnyTool[], name: string): AnyTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool
}

export function outputOf(outcome: ToolCallOutcome): string {
  return outcome.settlement.output
}

/** Whether a process exists and is not a zombie. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === "linux") {
    const stat = safeRead(`/proc/${pid}/stat`)
    return stat !== "" && !/\) Z /.test(stat)
  }
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim()
  return state !== "" && !state.startsWith("Z")
}

function safeRead(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

import type { NewEvent, SessionId, StoredEvent } from "@light-harness/core"
import type { Scenario } from "@light-harness/core/testing/scenarios"
import type { Engine, EngineEvent } from "../src/engine.ts"
import { type Io, run } from "../src/main.ts"
import { PrettyRenderer, type PrettyOptions } from "../src/renderer.ts"

export const CLI = new URL("../src/main.ts", import.meta.url).pathname

/** Gives events their place in a log: dense `seq` from 1 and `time = seq * 100` ms. */
export function stored(events: readonly NewEvent[]): StoredEvent[] {
  return events.map((item, index) => ({ ...item, sessionId: "ses_test" as SessionId, seq: index + 1, time: (index + 1) * 100 }) as StoredEvent)
}

export const durableEvents = (scenario: Scenario) => stored(scenario.phases.flatMap((phase) => phase.events))

/** Renders events as plain text (no colour, no status line), the way a pipe or log file would get them. */
export function render(events: readonly EngineEvent[], options: Partial<PrettyOptions> = {}): string {
  let out = ""
  const renderer = new PrettyRenderer({
    write: (text) => {
      out += text
    },
    color: false,
    columns: () => 80,
    live: false,
    showReasoning: false,
    echoPrompts: true,
    ...options,
  })
  for (const item of events) renderer.event(item)
  return out
}

export interface CliRun {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** Runs the CLI in-process with captured output. */
export async function runCli(
  argv: readonly string[],
  options: {
    stdin?: string
    stdinTTY?: boolean
    stdoutTTY?: boolean
    env?: Record<string, string>
    columns?: number
    engine?: () => Engine
    realEngineModule?: string
    /** Keyboard input for the interactive mode: called with the function that types into it. */
    keys?: (type: (data: string) => void) => void
    onSignal?: Io["onSignal"]
  } = {},
): Promise<CliRun> {
  let out = ""
  let err = ""
  const io: Io = {
    argv,
    env: options.env ?? {},
    cwd: process.cwd(),
    stdout: {
      write: (text) => {
        out += text
      },
      isTTY: options.stdoutTTY ?? false,
      columns: () => options.columns ?? 80,
    },
    stderr: {
      write: (text) => {
        err += text
      },
    },
    stdin: {
      isTTY: options.stdinTTY ?? false,
      readAll: async () => options.stdin ?? "",
      listen: (onData) => {
        options.keys?.(onData)
        return () => {}
      },
    },
    onSignal: options.onSignal ?? (() => () => {}),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`)
    },
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.realEngineModule === undefined ? {} : { realEngineModule: options.realEngineModule }),
  }
  const code = await run(io)
  return { code, out, err }
}

/** Replaces durations such as `180ms`, `2.1s` and `1m05s`, which depend on replay timing. */
export function withoutDurations(text: string): string {
  return text.replace(/\b\d+m\d{2}s\b|\b\d+(\.\d+)?(ms|s)\b/g, "<t>")
}

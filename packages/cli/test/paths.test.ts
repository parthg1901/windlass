/**
 * The CLI's behaviour through every way it reaches the engine, from one
 * parameterised suite: `direct` (the engine in this process, the reference),
 * `acp-memory` (the ACP client and server in this process) and `acp` (the
 * default: `lh acp` as a child process). Every scenario is played through all
 * three with the same scripted model and the same workspace, and what the
 * user sees (stdout, stderr, the exit code, the files) must be the same apart
 * from IDs, times and the temporary directory. Any difference is a failure.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT_ENV, scriptedProvider } from "@light-harness/acp"
import { brand, createHarness, type SessionId } from "@light-harness/core"
import { FakeProvider } from "@light-harness/core/testing"
import { createAcpEngine } from "../src/acp-engine.ts"
import type { Engine } from "../src/engine.ts"
import type { Io } from "../src/main.ts"
import { createRealEngine } from "../src/real-engine.ts"
import { type CliRun, runCli, withoutDurations } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

export const PATHS = ["direct", "acp-memory", "acp"] as const
const HOLD = new URL("./fixtures/hold-session.ts", import.meta.url).pathname
export type Path = (typeof PATHS)[number]

// Every scenario runs three times, one of them through a child process per CLI run.
setDefaultTimeout(60_000)

const scratch: string[] = []
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

type Item = Record<string, unknown>
/** A scripted model: one response per model call. The same file drives every path (`LH_ACP_SCRIPT` for the child). */
type Script = readonly (readonly Item[])[]

const text = (value: string): Item => ({ type: "text", text: value })
const reasoning = (value: string): Item => ({ type: "reasoning", text: value })
const call = (callId: string, name: string, input: Item): Item => ({ type: "tool_call", callId, name, input })
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number): Item => ({ type: "usage", inputTokens, cachedInputTokens, outputTokens })

/** One path's world: its own data directory and workspace, with the same files in it. */
interface Place {
  readonly path: Path
  readonly root: string
  readonly workspace: string
  readonly xdg: string
  readonly dataDir: string
  readonly scriptFile: string
  /** What the child engine's server wrote to stderr; the CLI forwards it. */
  readonly serverErr: string[]
  /** An engine factory for one CLI run. */
  engine(options?: { signedOut?: boolean }): Promise<() => Engine>
}

function place(path: Path, script: Script, files: Record<string, string> = {}): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `lh-paths-${path}-`)))
  scratch.push(root)
  const workspace = join(root, "work")
  mkdirSync(workspace)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(workspace, name, ".."), { recursive: true })
    writeFileSync(join(workspace, name), content)
  }
  const xdg = join(root, "xdg")
  const dataDir = join(xdg, brand.directory)
  const scriptFile = join(root, "script.json")
  writeFileSync(scriptFile, JSON.stringify({ responses: script }))
  const serverErr: string[] = []
  const signedOut = async () => ({ signedIn: false as const, message: "Not signed in. Run the sign-in first." })
  return {
    path,
    root,
    workspace,
    xdg,
    dataDir,
    scriptFile,
    serverErr,
    engine: async (options = {}) => {
      // A fresh model per run, as a new `lh` process would have: each run plays the script from its start.
      const provider = options.signedOut ? undefined : await scriptedProvider(scriptFile)
      const harness = {
        dataDir,
        log: (line: string) => serverErr.push(`${brand.binary}: ${line}\n`),
        ...(provider === undefined ? { provider: new FakeProvider([]), signIn: signedOut } : { provider }),
      }
      switch (path) {
        case "direct":
          return () => createRealEngine(harness)
        case "acp-memory":
          return () => createAcpEngine({ transport: "memory", harness, stderr: (line) => serverErr.push(line) })
        case "acp": {
          const env: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: xdg, [SCRIPT_ENV]: options.signedOut ? "" : scriptFile }
          return () => createAcpEngine({ transport: "child", env, stderr: (line) => serverErr.push(line) })
        }
      }
    },
  }
}

/** What a run shows, with what differs between paths by nature replaced: IDs, times, durations, the directory. */
function normalize(value: string, at: Place): string {
  return withoutDurations(
    value
      .replaceAll(at.root, "<root>")
      .replace(/\b(ses|msg|exe|req|run)_[0-9a-f]{8,}\b/g, "<$1>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      // Fingerprints of what depends on the directory's name (the environment section of the prompt, a check's inputs).
      .replace(/\b[0-9a-f]{64}\b/g, "<fingerprint>")
      .replace(/"durationMs":\d+/g, '"durationMs":0')
      .replace(/"time":\d+/g, '"time":0')
      .replace(/"(updatedAt|takenAt|startedAt|endedAt)":\d+/g, '"$1":0')
      .replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, "<when>")
      .replace(/pid \d+/g, "pid <pid>")
      .replace(/process \d+/g, "process <pid>"),
  )
}

interface Shown {
  readonly code: number
  readonly out: string
  readonly err: string
}

type RunOptions = Parameters<typeof runCli>[1] & { readonly signedOut?: boolean; readonly terminal?: number }

/** One CLI run in `at`'s workspace through its path. */
async function cli(at: Place, argv: readonly string[], options: RunOptions = {}): Promise<Shown & { raw: CliRun }> {
  const engine = await at.engine(options.signedOut === undefined ? {} : { signedOut: options.signedOut })
  const raw = await runCli(["--cwd", at.workspace, ...argv], { ...options, engine })
  const out = options.terminal === undefined ? raw.out : rendered(raw.out, options.terminal)
  return { code: raw.code, out: normalize(out, at), err: normalize(raw.err + at.serverErr.splice(0).join(""), at), raw }
}

/** What a terminal of `columns` shows after the output, for the interactive mode. */
function rendered(out: string, columns: number): string {
  const vt = new VirtualTerminal(columns)
  vt.write(out)
  return vt.text
}

/** Plays `scenario` through every path and expects each to show the same as `direct`. Returns what each showed. */
async function everyPath<T extends Record<string, unknown>>(scenario: (path: Path) => Promise<T>): Promise<Record<Path, T>> {
  const results = {} as Record<Path, T>
  for (const path of PATHS) results[path] = await scenario(path)
  for (const path of PATHS) expect({ path, ...results[path] }).toEqual({ path, ...results.direct })
  return results
}

/** Signal handlers the CLI subscribed, so a test can press Ctrl-C or send SIGTERM. */
function signals() {
  const handlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {}
  const onSignal: Io["onSignal"] = (signal, handler) => {
    handlers[signal] = handler
    return () => {
      if (handlers[signal] === handler) delete handlers[signal]
    }
  }
  return { onSignal, press: (signal: "SIGINT" | "SIGTERM") => handlers[signal]?.() }
}

/** Calls `act` once, `delayMs` after the first time the output so far matches `pattern`. */
function when(pattern: RegExp | string, act: () => void, delayMs = 10) {
  let seen = ""
  let done = false
  return (chunk: string) => {
    if (done) return
    seen += chunk
    if (typeof pattern === "string" ? seen.includes(pattern) : pattern.test(seen)) {
      done = true
      setTimeout(act, delayMs)
    }
  }
}

const WRITE_THEN_ANSWER: Script = [
  [reasoning("Look first."), call("c1", "write", { path: "notes.md", content: "# Notes\n\n- reviewed\n" })],
  [text("Added the line."), usage(1200, 1000, 40)],
]

describe("one prompt, every path", () => {
  test("pretty output, the files and the exit code", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, WRITE_THEN_ANSWER, { "notes.md": "# Notes\n" })
      const run = await cli(at, ["add a line to the notes"])
      return { code: run.code, out: run.out, err: run.err, notes: readFileSync(join(at.workspace, "notes.md"), "utf8") }
    })
    expect(results.acp.code).toBe(0)
    expect(results.acp.out).toContain("▸ write notes.md")
    expect(results.acp.out).toContain("· changed 1 file: notes.md")
    expect(results.acp.out).toContain("✓ done · no checks configured")
    expect(results.acp.notes).toContain("reviewed")
  })

  test("--json: every event as one JSON line, the same stream through every path", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, WRITE_THEN_ANSWER, { "notes.md": "# Notes\n" })
      const run = await cli(at, ["--json", "add a line to the notes"])
      return { code: run.code, out: run.out, err: run.err }
    })
    const lines = results.acp.out.trim().split("\n")
    const types = lines.map((line) => (JSON.parse(line) as { type: string }).type)
    expect(types[0]).toBe("session.created")
    expect(types).toContain("text.delta")
    expect(types).toContain("workspace.changes")
    expect(types.at(-1)).toBe("execution.succeeded")
  })

  test("--quiet prints only the answer", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, WRITE_THEN_ANSWER, { "notes.md": "# Notes\n" })
      return cli(at, ["--quiet", "add a line"]).then(({ code, out, err }) => ({ code, out, err }))
    })
    expect(results.acp).toEqual({ code: 0, out: "Added the line.\n", err: "" })
  })

  test("a turn that fails exits 1, with the reason", async () => {
    const failing: Script = [[{ type: "fail", kind: "invalid_request", message: "the request was malformed" }]]
    const results = await everyPath(async (path) => {
      const at = place(path, failing)
      const pretty = await cli(at, ["do it"])
      const json = await cli(at, ["--json", "do it"])
      return { pretty: [pretty.code, pretty.out, pretty.err], json: [json.code, json.out.split("\n").map((line) => line.slice(0, 40)).join("\n"), json.err] }
    })
    expect(results.acp.pretty[0]).toBe(1)
  })

  test("--max-steps: the turn's step limit reaches the engine", async () => {
    const looping: Script = [[call("c1", "ls", {})], [call("c2", "ls", {})], [text("Stopping here.")]]
    const results = await everyPath(async (path) => {
      const at = place(path, looping, { "a.txt": "a\n" })
      const run = await cli(at, ["--json", "--max-steps", "1", "look around"])
      const notes = run.out
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data?: { origin?: string } })
        .filter((item) => item.type === "synthetic.appended")
        .map((item) => item.data?.origin)
      return { code: run.code, notes, last: run.out.trim().split("\n").at(-1)?.slice(0, 30) }
    })
    expect(results.acp.notes).toContain("step_limit")
  })

  test("the verification gate's three endings: passed (0), not configured (0), unresolved (3)", async () => {
    const config = (command: string) => JSON.stringify({ checks: [{ name: "lint", command }], verify: { mode: "report" } })
    const results = await everyPath(async (path) => {
      const shown: Record<string, unknown> = {}
      const setups: Record<string, Record<string, string>> = {
        passed: { ".light-harness/config.json": config("true") },
        unresolved: { ".light-harness/config.json": config("echo lint failed; exit 1") },
        none: {},
      }
      for (const [name, files] of Object.entries(setups)) {
        const at = place(path, WRITE_THEN_ANSWER, { "notes.md": "# Notes\n", ...files })
        const run = await cli(at, ["add a line"])
        const json = await cli(at, ["--json", "--continue", "again"])
        shown[name] = { code: run.code, out: run.out, err: run.err, last: json.out.trim().split("\n").at(-1) }
      }
      return shown
    })
    const shown = results.acp as Record<string, { code: number; out: string }>
    expect(shown.passed!.code).toBe(0)
    expect(shown.none!.code).toBe(0)
    expect(shown.unresolved!.code).toBe(3)
    expect(shown.unresolved!.out).toContain("lint")
  })
})

describe("stopping, every path", () => {
  const SLEEP: Script = [[call("c1", "shell", { command: "sleep 20" })], [text("never reached")]]

  test("Ctrl-C during a shell command stops the turn (130); the command is stopped", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, SLEEP)
      const keys = signals()
      const started = Date.now()
      const run = await cli(at, ["--json", "wait a while"], { onSignal: keys.onSignal, onWrite: when('"type":"tool.started"', () => keys.press("SIGINT")) })
      const types = run.out
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type)
      return { code: run.code, types: types.slice(types.indexOf("execution.interrupt_requested")), err: run.err, quick: Date.now() - started < 15_000 }
    })
    expect(results.acp.code).toBe(130)
    expect(results.acp.types.at(-1)).toBe("execution.interrupted")
    expect(results.acp.quick).toBe(true)
  })

  test("SIGTERM mid-turn stops the work as a shutdown (143), and the next run takes the session up again", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, [...SLEEP.slice(0, 1), [text("Picked up again.")]])
      const keys = signals()
      const run = await cli(at, ["wait a while"], { onSignal: keys.onSignal, onWrite: when("▸ shell", () => keys.press("SIGTERM"), 400) })
      // The next process plays the script from the start: its first answer is the sleep again, so ask for the listing only.
      const listed = await cli(at, ["--list-sessions"])
      return { code: run.code, out: run.out, err: run.err, listed: listed.out }
    })
    expect(results.acp.code).toBe(143)
    expect(results.acp.out).toContain("stopped")
  })
})

describe("sessions, every path", () => {
  test("--continue and --session take up the same session; --list-sessions shows it once", async () => {
    const twice: Script = [[text("First answer.")], [text("Second answer.")]]
    await everyPath(async (path) => {
      const at = place(path, twice)
      const first = await cli(at, ["--json", "first"])
      const id = (JSON.parse(first.raw.out.split("\n")[0]!) as { sessionId: string }).sessionId
      const continued = await cli(at, ["--continue", "second"])
      const named = await cli(at, ["--session", id.slice(0, 12), "third"])
      const listed = await cli(at, ["--list-sessions"])
      const json = await cli(at, ["--list-sessions", "--json"])
      const rows = json.raw.out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(rows.map((row) => row.id)).toEqual([id])
      expect(Object.keys(rows[0]!)).toEqual(["id", "title", "cwd", "updatedAt", "model"])
      return { first: first.code, continued: [continued.code, continued.out], named: [named.code, named.out], listed: listed.out }
    })
  })

  test("what cannot be opened is said in one line: no session to continue, an unknown one, an unknown model", async () => {
    await everyPath(async (path) => {
      const at = place(path, [[text("Hello.")]])
      const none = await cli(at, ["--continue", "hello"])
      const unknown = await cli(at, ["--session", "ses_nope", "hello"])
      const models = await cli(at, ["--models"])
      return { none: [none.code, none.out, none.err], unknown: [unknown.code, unknown.out, unknown.err], models: [models.code, models.out, models.err] }
    })
  })

  test("not signed in: the same sentence and exit code 1", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, [])
      const run = await cli(at, ["hello"], { signedOut: true })
      return { code: run.code, out: run.out, err: run.err }
    })
    expect(results.acp.code).toBe(1)
    expect(results.acp.err).toBe(`${brand.binary}: not signed in; run \`${brand.binary} login\` to sign in with ChatGPT, then try again\n`)
  })

  test("a session another process works in is refused with a sentence that names that process", async () => {
    const results = await everyPath(async (path) => {
      const at = place(path, [[text("Hello.")]])
      // Another process holds the session: a terminal or an editor working in it.
      const holder = Bun.spawn([process.execPath, HOLD, at.dataDir, at.workspace], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
      try {
        const reader = holder.stdout.getReader()
        const id = new TextDecoder().decode((await reader.read()).value).trim()
        const run = await cli(at, ["--session", id, "hello"])
        return { code: run.code, out: run.out, err: run.err.replace(String(holder.pid), "<pid>") }
      } finally {
        holder.stdin.end()
        await holder.exited
      }
    })
    expect(results.acp.code).toBe(1)
    expect(results.acp.err).toContain("pid <pid>")
  })
})

describe("the interactive mode, every path", () => {
  test("a steer mid-turn and /queue, then /undo asks about a hand edit, then /redo", async () => {
    const script: Script = [
      [call("c1", "write", { path: "notes.md", content: "# Notes\n\n- reviewed\n" })],
      [call("c2", "shell", { command: "sleep 0.6" })],
      [text("Done, and checked b too.")],
      [text("The docs are updated.")],
    ]
    const results = await everyPath(async (path) => {
      const at = place(path, script, { "notes.md": "# Notes\n" })
      let type: (data: string) => void = () => {}
      const steps: [RegExp | string, () => void][] = [
        [/›\s*$/, () => type("add a line to the notes\r")],
        ["▸ shell", () => type("also check b\r")],
        ["also check b", () => type("/queue then the docs\r")],
        ["The docs are updated.", () => {}],
        [/updated\.[\s\S]*›\s*$/, () => {
          writeFileSync(join(at.workspace, "notes.md"), "# Notes\n\nmine\n")
          type("/undo\r")
        }],
        ["overwrite them?", () => type("y\r")],
        [/went back[\s\S]*›\s*$/, () => type("/redo\r")],
        [/brought back[\s\S]*›\s*$/, () => type("\x04")],
      ]
      let seen = ""
      let next = 0
      const run = await cli(at, [], {
        stdinTTY: true,
        terminal: 100,
        keys: (typer) => {
          type = typer
        },
        onWrite: (chunk) => {
          seen += chunk
          const step = steps[next]
          if (step === undefined) return
          const [pattern, act] = step
          const plain = rendered(seen, 100)
          if (typeof pattern === "string" ? plain.includes(pattern) : pattern.test(plain)) {
            next += 1
            setTimeout(act, 30)
          }
        },
      })
      return { code: run.code, out: run.out, err: run.err, steps: next, notes: readFileSync(join(at.workspace, "notes.md"), "utf8") }
    })
    const shown = results.acp
    expect(shown.steps).toBe(8)
    expect(shown.code).toBe(0)
    expect(shown.out).toContain("also check b")
    expect(shown.out).toContain("you edited 1 file by hand since then: notes.md")
    expect(shown.out).toContain("↷ brought back")
    // /redo brings back the workspace as it was right before the /undo: the hand edit.
    expect(shown.notes).toBe("# Notes\n\nmine\n")
  }, 60_000)
})

test("the child path leaves no server behind and writes nothing of its own to stderr", async () => {
  const at = place("acp", WRITE_THEN_ANSWER, { "notes.md": "# Notes\n" })
  const run = await cli(at, ["--quiet", "add a line"])
  expect(run).toMatchObject({ code: 0, out: "Added the line.\n", err: "" })
  // The server let go of the session before it exited: another process opens it at once.
  const holder = createHarness({ dataDir: at.dataDir, provider: new FakeProvider([]), log: () => {} })
  try {
    const id = holder.engine.latestSession(at.workspace)!.session.id as SessionId
    const session = holder.engine.openSession(id)
    await session.close()
  } finally {
    await holder.close()
  }
  expect(existsSync(at.dataDir)).toBe(true)
})

/**
 * Every way out of the CLI, with the CLI as a real subprocess: it calls the
 * engine's close, waits for it a bounded time, and exits with the code that
 * says why. The fake engine reports `started <tool>`, `close` and `closed` to a
 * trace file; a test that signals mid-turn waits for the command to be running.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { CLOSE_TIMEOUT_MS } from "../src/engine.ts"
import { DEMO_TRACE_ENV } from "../src/main.ts"
import { E2E_TIMEOUT_MS, waitFor } from "@windlass/core/testing"
import { CLI } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const dir = mkdtempSync(join(tmpdir(), "cli-exit-"))
const running: Subprocess[] = []
let traces = 0

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function start(args: string[], options: { shell?: boolean } = {}) {
  traces += 1
  const trace = join(dir, `trace-${traces}`)
  const argv = options.shell === true ? ["bash", "-c", args.join(" ")] : ["bun", CLI, ...args]
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, [DEMO_TRACE_ENV]: trace, NO_COLOR: "1" } })
  running.push(proc)
  const output = { out: "", err: "" }
  const decoder = new TextDecoder()
  const errors = new TextDecoder()
  const done = Promise.all([
    (async () => {
      for await (const chunk of proc.stdout) output.out += decoder.decode(chunk, { stream: true })
    })(),
    (async () => {
      for await (const chunk of proc.stderr) output.err += errors.decode(chunk, { stream: true })
    })(),
  ])
  const read = () => {
    try {
      return readFileSync(trace, "utf8")
    } catch {
      return ""
    }
  }
  /** What the engine was told about closing, in order. */
  const traced = () =>
    read()
      .split("\n")
      .filter((line) => line === "close" || line === "closed")
      .map((line) => `${line}\n`)
      .join("")
  const shown = (needle: string) => waitFor(() => output.out.includes(needle), { timeoutMs: 20_000, what: JSON.stringify(needle), describe: () => `output so far:\n${output.out}` })
  /** Waits until the scripted shell command is running, so a signal stops a running command. */
  const commandRunning = () => waitFor(() => read().includes("started shell\n"), { timeoutMs: 20_000, what: "the command to start", describe: () => `output so far:\n${output.out}` })
  return { proc, output, done, waitFor: shown, commandRunning, traced }
}

describe("exit paths", () => {
  test("a normal end closes the engine and exits with the turn's code", async () => {
    const cli = start(["--demo", "a-plain-answer", "--demo-speed", "0"])
    expect(await cli.proc.exited).toBe(0)
    expect(cli.traced()).toBe("close\nclosed\n")
  })

  test("a turn that ends with failing checks left unresolved exits with 3, and --json says so in its last event and its summary", async () => {
    const cli = start(["--demo", "the-checks-still-fail-after-the-last-allowed-round", "--demo-speed", "0", "--json", "Fix it."])
    expect(await cli.proc.exited).toBe(3)
    await cli.done
    const [last, summary] = cli.output.out.trim().split("\n").slice(-2).map((line) => JSON.parse(line)) as [{ type: string; data: { verification: { status: string; reason: string; failing: string[] } } }, { type: string; outcome: string }]
    expect(summary).toMatchObject({ type: "cli.summary", outcome: "unresolved" })
    expect(last.type).toBe("execution.succeeded")
    expect(last.data.verification).toMatchObject({ status: "unresolved", reason: "max_rounds", failing: ["test"] })
    // The same turn with passing checks is a plain success.
    const passing = start(["--demo", "the-checks-pass", "--demo-speed", "0", "--json", "Fix it."])
    expect(await passing.proc.exited).toBe(0)
  })

  test("Ctrl-C mid-turn: the engine is closed after the stop and the code is 130", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "100"])
    await cli.commandRunning()
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)

  test("SIGTERM mid-turn stops the work as a shutdown, closes the engine and exits with 143", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "100"])
    await cli.commandRunning()
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    await cli.done
    expect(cli.output.out).toContain("■ shutting down…\n")
    expect(cli.output.out).toMatch(/■ stopped for shutdown · the turn resumes at the next start\n$/)
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)

  test("an engine that does not stop in time does not hold the exit up", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "60000"])
    await cli.commandRunning()
    const sent = Date.now()
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    // The engine would take a minute; the exit waits only the close timeout. The slack is for a loaded runner,
    // where the process takes a few seconds to wind down and exit, and is still far below the engine's minute.
    expect(Date.now() - sent).toBeLessThan(CLOSE_TIMEOUT_MS + 8_000)
    await cli.done
    expect(cli.output.err).toContain("the engine did not stop within 3.0s; exiting anyway\n")
    expect(cli.traced()).toBe("close\n")
  }, 30_000)

  test("a reader that goes away (| head) closes the engine and exits with 141, quietly", async () => {
    const cli = start([`bun ${CLI} --demo a-long-build-command --json | head -n 3 >/dev/null; echo "cli=\${PIPESTATUS[0]}" >&2`], { shell: true })
    expect(await cli.proc.exited).toBe(0)
    await cli.done
    expect(cli.output.err).toBe("cli=141\n")
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)

  test("SIGTERM while idle between demo turns still closes and exits with 143", async () => {
    const cli = start(["--demo", "a-content-policy-refusal"])
    await cli.waitFor("✓ done")
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)
})

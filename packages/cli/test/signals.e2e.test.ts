/**
 * Ctrl-C while a turn runs, through the fake engine, with the CLI as a real
 * subprocess receiving SIGINT. The demo used runs one shell command for
 * several seconds, so there is time to interrupt it.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { E2E_TIMEOUT_MS, waitFor } from "@windlass/core/testing"
import { DEMO_TRACE_ENV } from "../src/main.ts"
import { CLI } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const dir = mkdtempSync(join(tmpdir(), "cli-signals-"))
const running: Subprocess[] = []
let traces = 0

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function start(...args: string[]) {
  traces += 1
  const trace = join(dir, `trace-${traces}`)
  const proc = Bun.spawn(["bun", CLI, "--demo", "a-long-build-command", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, [DEMO_TRACE_ENV]: trace } })
  running.push(proc)
  const output = { text: "" }
  const decoder = new TextDecoder()
  const done = (async () => {
    for await (const chunk of proc.stdout) output.text += decoder.decode(chunk, { stream: true })
  })()
  const shown = (needle: string) => waitFor(() => output.text.includes(needle), { timeoutMs: 20_000, what: JSON.stringify(needle), describe: () => `output so far:\n${output.text}` })
  const traced = () => {
    try {
      return readFileSync(trace, "utf8")
    } catch {
      return ""
    }
  }
  /** Waits until the scripted command is running (the fake engine says so in its trace), so Ctrl-C stops a running command. */
  const commandRunning = () => waitFor(() => traced().includes("started shell\n"), { timeoutMs: 20_000, what: "the command to start", describe: () => `output so far:\n${output.text}` })
  return { proc, output, done, waitFor: shown, commandRunning }
}

describe("Ctrl-C while a turn runs", () => {
  test("the first asks the engine to stop and says so; the turn ends interrupted with 130", async () => {
    const cli = start()
    await cli.waitFor("▸ shell bun run build && bun test\n")
    await cli.commandRunning()
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    await cli.done
    const text = cli.output.text
    expect(text).toContain("■ stopping… press Ctrl-C again to exit now\n")
    expect(text).toMatch(/  ✗ shell bun run build && bun test · stopped · [\d.]+m?s\n    Stopped by the user after \d+ s\. Output so far:\n/)
    expect(text).toMatch(/\n■ interrupted · [\d.]+s\n$/)
    expect(text).not.toContain("✓ done")
  }, 30_000)

  test("a second within two seconds exits at once, without waiting for the stop", async () => {
    const cli = start("--demo-grace", "20000")
    await cli.waitFor("▸ shell bun run build && bun test\n")
    await cli.commandRunning()
    cli.proc.kill("SIGINT")
    await cli.waitFor("■ stopping")
    const sent = Date.now()
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    // The stop would take 20 s; the exit does not wait for it. The slack is for a loaded runner's process exit.
    expect(Date.now() - sent).toBeLessThan(10_000)
    await cli.done
    expect(cli.output.text).toContain("exiting without waiting for the stop\n")
    expect(cli.output.text).not.toContain("■ interrupted")
  }, 30_000)

  test("a second more than two seconds later is a new first press, not an exit", async () => {
    // The stop takes 10 s, so the second press lands while it is still under way even on a loaded runner.
    const cli = start("--demo-grace", "10000")
    await cli.waitFor("▸ shell bun run build && bun test\n")
    await cli.commandRunning()
    cli.proc.kill("SIGINT")
    await cli.waitFor("■ stopping")
    // Time passing is the point: the double-press window is 2 s, counted from the first press, which the CLI handled
    // before it printed "stopping", so this wait always lands outside the window however slow the runner is.
    await Bun.sleep(2_300)
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    await cli.done
    expect(cli.output.text.split("■ stopping…").length - 1).toBe(1)
    expect(cli.output.text).toContain("■ still stopping… press Ctrl-C again to exit now\n")
    expect(cli.output.text).toContain("· stopped · ")
    expect(cli.output.text).toContain("■ interrupted")
  }, 30_000)
})

/**
 * Every way out of the CLI, with the CLI as a real subprocess: it calls the
 * engine's close, waits for it a bounded time, and exits with the code that
 * says why. The fake engine reports `close` and `closed` to a trace file.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { CLOSE_TIMEOUT_MS } from "../src/engine.ts"
import { DEMO_TRACE_ENV } from "../src/main.ts"
import { CLI } from "./helpers.ts"

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
  const waitFor = async (needle: string, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs
    while (!output.out.includes(needle)) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; output so far:\n${output.out}`)
      await Bun.sleep(25)
    }
  }
  const traced = () => {
    try {
      return readFileSync(trace, "utf8")
    } catch {
      return ""
    }
  }
  return { proc, output, done, waitFor, traced }
}

describe("exit paths", () => {
  test("a normal end closes the engine and exits with the turn's code", async () => {
    const cli = start(["--demo", "a-plain-answer", "--demo-speed", "0"])
    expect(await cli.proc.exited).toBe(0)
    expect(cli.traced()).toBe("close\nclosed\n")
  })

  test("Ctrl-C mid-turn: the engine is closed after the stop and the code is 130", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "100"])
    await cli.waitFor("▸ shell")
    await Bun.sleep(400)
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)

  test("SIGTERM mid-turn stops the work as a shutdown, closes the engine and exits with 143", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "100"])
    await cli.waitFor("▸ shell")
    await Bun.sleep(400)
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    await cli.done
    expect(cli.output.out).toContain("■ shutting down…\n")
    expect(cli.output.out).toMatch(/■ stopped for shutdown · the turn resumes at the next start\n$/)
    expect(cli.traced()).toBe("close\nclosed\n")
  }, 30_000)

  test("an engine that does not stop in time does not hold the exit up", async () => {
    const cli = start(["--demo", "a-long-build-command", "--demo-grace", "60000"])
    await cli.waitFor("▸ shell")
    await Bun.sleep(400)
    const sent = Date.now()
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    expect(Date.now() - sent).toBeLessThan(CLOSE_TIMEOUT_MS + 2_000)
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

/**
 * Ctrl-C while a turn runs, through the fake engine, with the CLI as a real
 * subprocess receiving SIGINT. The demo used runs one shell command for
 * several seconds, so there is time to interrupt it.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"
import { CLI } from "./helpers.ts"

const running: Subprocess[] = []

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL")
})

function start(...args: string[]) {
  const proc = Bun.spawn(["bun", CLI, "--demo", "a-long-build-command", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  running.push(proc)
  const output = { text: "" }
  const decoder = new TextDecoder()
  const done = (async () => {
    for await (const chunk of proc.stdout) output.text += decoder.decode(chunk, { stream: true })
  })()
  const waitFor = async (needle: string, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs
    while (!output.text.includes(needle)) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; output so far:\n${output.text}`)
      await Bun.sleep(25)
    }
  }
  return { proc, output, done, waitFor }
}

describe("Ctrl-C while a turn runs", () => {
  test("the first asks the engine to stop and says so; the turn ends interrupted with 130", async () => {
    const cli = start()
    await cli.waitFor("▸ shell bun run build && bun test\n")
    await Bun.sleep(400) // the command starts running shortly after its call is recorded
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
    await Bun.sleep(400)
    cli.proc.kill("SIGINT")
    await cli.waitFor("■ stopping")
    const sent = Date.now()
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    expect(Date.now() - sent).toBeLessThan(5_000)
    await cli.done
    expect(cli.output.text).toContain("exiting without waiting for the stop\n")
    expect(cli.output.text).not.toContain("■ interrupted")
  }, 30_000)

  test("a second more than two seconds later is a new first press, not an exit", async () => {
    const cli = start("--demo-grace", "4000")
    await cli.waitFor("▸ shell bun run build && bun test\n")
    await Bun.sleep(400)
    cli.proc.kill("SIGINT")
    await cli.waitFor("■ stopping")
    await Bun.sleep(2_300)
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    await cli.done
    expect(cli.output.text.split("■ stopping").length - 1).toBe(2)
    expect(cli.output.text).toContain("· stopped · ")
    expect(cli.output.text).toContain("■ interrupted")
  }, 30_000)
})

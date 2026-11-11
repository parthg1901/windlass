import { afterEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { createInterrupt } from "../../src/interrupt.ts"
import type { ToolProgress } from "../../src/tool/tool.ts"
import { context, isRunning, outputOf, workspace, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

type ShellDisplay = { exitCode: number | null; signal: string | null; timedOut: boolean; interrupted: string | null; durationMs: number }

const STOPPED = "The command and its child processes were stopped; the output above is everything it printed before that."

/** Waits until every pid is gone (or fails after `ms`); the kill sequence has already run when this is called. */
async function expectAllGone(pids: number[], ms = 500) {
  const deadline = performance.now() + ms
  while (pids.some(isRunning) && performance.now() < deadline) await Bun.sleep(20)
  expect(pids.filter(isRunning)).toEqual([])
}

function pidsIn(output: string): number[] {
  return [...output.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))
}

describe("shell", () => {
  test("runs in the working directory with combined output in arrival order", async () => {
    const ws = workspace()
    const outcome = await ws.call("shell", { command: "pwd; echo out; sleep 0.05; echo err >&2; sleep 0.05; echo out2" })
    expect(outcome.settlement).toMatchObject({ outcome: "success", output: `${ws.root}\nout\nerr\nout2\n`, truncation: null })
    expect(outcome.settlement.display).toMatchObject({ exitCode: 0, signal: null, timedOut: false, interrupted: null })
  })

  test("a non-zero exit code is stated in the output and in display", async () => {
    const ws = workspace()
    const outcome = await ws.call("shell", { command: "printf partial; exit 3" })
    expect(outcome.settlement).toMatchObject({ outcome: "error", output: "partial\n[Exit code 3]", display: { exitCode: 3 } })
    expect(outputOf(await ws.call("shell", { command: "exit 1" }))).toBe("(no output)\n[Exit code 1]")
    expect(outputOf(await ws.call("shell", { command: "true" }))).toBe("(no output)")
    expect(outputOf(await ws.call("shell", { command: "kill -9 $$" }))).toBe("(no output)\n[Killed by signal SIGKILL]")
  })

  test("stdin is empty and never waited on", async () => {
    const ws = workspace()
    const outcome = await ws.call("shell", { command: 'cat; read line; echo "read:[$line] $?"' })
    expect(outputOf(outcome)).toBe("read:[] 1\n")
  })

  test("a command that cannot start is an error", async () => {
    const ws = workspace()
    const outcome = await ws.runtime.run({
      name: "shell",
      argumentsText: '{"command":"true"}',
      context: context(`${ws.root}/missing`),
    })
    expect(outcome.settlement.outcome).toBe("error")
    expect(outputOf(outcome)).toStartWith("Could not start the command: ")
  })

  test("timeout stops the command and says so", async () => {
    const ws = workspace()
    const begin = performance.now()
    const outcome = await ws.call("shell", { command: "echo pid=$$; echo before; sleep 30", timeout: 1 })
    const elapsed = performance.now() - begin
    expect(elapsed).toBeGreaterThanOrEqual(990)
    expect(elapsed).toBeLessThan(2000)
    expect(outputOf(outcome)).toEndWith(`before\n[Timed out after 1 second. ${STOPPED}]`)
    expect(outcome.settlement).toMatchObject({ outcome: "error", display: { timedOut: true, exitCode: null, signal: "SIGTERM" } })
    await expectAllGone(pidsIn(outputOf(outcome)))
  })

  test("a command that ignores SIGTERM is killed after the grace period", async () => {
    const ws = workspace()
    const begin = performance.now()
    const outcome = await ws.call("shell", { command: "trap '' TERM; echo pid=$$; while true; do sleep 0.1; done", timeout: 1 })
    const elapsed = performance.now() - begin
    expect(elapsed).toBeGreaterThanOrEqual(3990)
    expect(elapsed).toBeLessThan(5500)
    expect(outcome.settlement.display).toMatchObject({ timedOut: true, signal: "SIGKILL" })
    await expectAllGone(pidsIn(outputOf(outcome)))
  }, 10_000)

  test("a grandchild that outlives the command is stopped with the whole group", async () => {
    const ws = workspace()
    const begin = performance.now()
    const quiet = await ws.call("shell", { command: "sleep 300 & echo pid=$!; echo done" })
    expect(performance.now() - begin).toBeLessThan(1500)
    expect(quiet.settlement).toMatchObject({ outcome: "success", display: { exitCode: 0 } })
    expect(outputOf(quiet)).toMatch(/^pid=\d+\ndone\n$/)
    await expectAllGone(pidsIn(outputOf(quiet)))

    const stubborn = await ws.call("shell", { command: "(trap '' TERM; exec sh -c 'echo pid=$$; exec sleep 300') & sleep 0.2; echo parent=$$" })
    expect(stubborn.settlement.outcome).toBe("success")
    expect(pidsIn(outputOf(stubborn))).toHaveLength(1)
    await expectAllGone([...pidsIn(outputOf(stubborn)), Number(/parent=(\d+)/.exec(outputOf(stubborn))![1])])
  }, 10_000)

  test("abort mid-output returns what was printed so far, after progress was reported", async () => {
    const ws = workspace()
    const token = createInterrupt()
    const progress: ToolProgress[] = []
    const begin = performance.now()
    const running = ws.call(
      "shell",
      { command: "echo pid=$$; i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.05; done" },
      { signal: token.signal, progress },
    )
    while (!progress.some((update) => update.text.includes("tick 3"))) await Bun.sleep(10)
    token.interrupt("user")
    const outcome = await running
    expect(performance.now() - begin).toBeLessThan(2000)
    const output = outputOf(outcome)
    expect(output).toStartWith("pid=")
    expect(output).toContain("tick 1\ntick 2\ntick 3\n")
    expect(output).toEndWith(`\n[Interrupted by the user. ${STOPPED}]`)
    expect(outcome.settlement).toMatchObject({ outcome: "error", display: { interrupted: "user", timedOut: false } })
    expect(outcome.kind).toBe("completed")
    await expectAllGone(pidsIn(output))
  })

  test("shutdown is reported as its own reason", async () => {
    const ws = workspace()
    const token = createInterrupt()
    setTimeout(() => token.interrupt("shutdown"), 100)
    const outcome = await ws.call("shell", { command: "sleep 30" }, { signal: token.signal })
    expect(outputOf(outcome)).toBe(`(no output)\n[Interrupted because the harness is shutting down. ${STOPPED}]`)
  })

  test("very large output is spilled and capped with bounded memory", async () => {
    const ws = workspace()
    Bun.gc(true)
    const baseline = process.memoryUsage().rss
    let peak = baseline
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5)
    const size = 200 * 1024 * 1024
    const outcome = await ws.call("shell", { command: `yes 'a line of output that repeats' | head -c ${size}; echo; echo the end` })
    clearInterval(sampler)
    const settlement = outcome.settlement
    const truncation = settlement.truncation!
    expect(truncation.originalBytes).toBe(size + "\nthe end\n".length)
    expect(truncation.originalLines).toBe(Math.ceil(size / "a line of output that repeats\n".length) + 1)
    expect(statSync(truncation.spillPath!).size).toBe(truncation.originalBytes)
    expect(Buffer.byteLength(settlement.output)).toBeLessThanOrEqual(50 * 1024)
    expect(settlement.output.split("\n").length).toBeLessThanOrEqual(2000)
    expect(settlement.output).toStartWith("a line of output that repeats\n")
    expect(settlement.output).toMatch(/\na line of output that repeats\na line of output tha\nthe end\n$/)
    expect(settlement.output).toContain(`of ${truncation.originalLines} lines. Full output: ${truncation.spillPath} (read it with offset `)
    // 200 MB went through; holding it would cost far more than this.
    expect(peak - baseline).toBeLessThan(96 * 1024 * 1024)
  }, 30_000)

  test("the spill file stops at its limit and the marker says how much it holds", async () => {
    const ws = workspace({ shell: { spillLimitBytes: 1024 * 1024 } })
    const outcome = await ws.call("shell", { command: "yes 0123456789 | head -c 5000000" })
    const truncation = outcome.settlement.truncation!
    expect(truncation.originalBytes).toBe(5_000_000)
    expect(statSync(truncation.spillPath!).size).toBe(1024 * 1024)
    expect(outputOf(outcome)).toContain(`The first 1048576 bytes are saved in ${truncation.spillPath}.]`)
  })

  test("small output leaves no spill file and the runtime does not change it", async () => {
    const ws = workspace()
    const outcome = await ws.call("shell", { command: "printf 'é😀\\n'" })
    expect(outcome.settlement).toMatchObject({ output: "é😀\n", truncation: null })
    expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: ws.spillDir }))).toEqual([])
  })

  test("display records the exit details", async () => {
    const ws = workspace()
    const display = (await ws.call("shell", { command: "exit 7" })).settlement.display as ShellDisplay
    expect(display).toEqual({ exitCode: 7, signal: null, timedOut: false, interrupted: null, durationMs: expect.any(Number) })
  })
})

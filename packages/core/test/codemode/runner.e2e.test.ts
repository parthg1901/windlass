/**
 * The program's process: its calls reach the host, its errors name their
 * line, its limits hold, and under the sandbox it can change nothing by
 * itself. The engine side (calls as calls of the step) is in
 * `test/engine/codemode.e2e.test.ts`.
 */
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODE_TOOL_SPEC, PROGRAM_LIMITS, type ProgramCallResult, type ProgramHost, renderOutcome, runProgram } from "../../src/codemode/index.ts"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import type { Confine } from "../../src/codemode/runner.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const base = mkdtempSync(join(tmpdir(), "wl-codemode-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let runs = 0

/** A host that answers every call with `name(arguments)`, after a moment, and records what it was asked. */
function recording(answer: (name: string, input: string) => ProgramCallResult = (name, input) => ({ status: "success", output: `${name}(${input})` })) {
  const asked: string[] = []
  const host: ProgramHost = {
    call: async (name, input) => {
      asked.push(`${name} ${input}`)
      await Bun.sleep(5)
      return answer(name, input)
    },
  }
  return { asked, host }
}

const run = (source: string, host: ProgramHost, more: Partial<Parameters<typeof runProgram>[0]> = {}) =>
  runProgram({ source, tools: ["read", "write", "grep"], host, signal: new AbortController().signal, dir: join(base, `run-${++runs}`), confine: null, ...more })

describe("a program", () => {
  test("calls the host for each function call, side by side when it does not wait, and returns what it printed and returned", async () => {
    const { asked, host } = recording()
    const outcome = await run(`const [a, b] = await Promise.all([read({ path: "a" }), read({ path: "b" })])\nconsole.log("got", a, { n: 1 })\nreturn { a, b }`, host)
    expect(asked).toEqual(['read {"path":"a"}', 'read {"path":"b"}'])
    expect(outcome.end).toEqual({ kind: "returned", value: JSON.stringify({ a: 'read({"path":"a"})', b: 'read({"path":"b"})' }, null, 2) })
    expect(outcome.printed).toBe('got read({"path":"a"}) {\n  n: 1,\n}\n')
    expect(outcome.calls).toBe(2)
  })

  test("the functions are globals, and the same under `tools` and `functions`", async () => {
    const { asked, host } = recording()
    await run(`await read({ path: "1" }); await tools.read({ path: "2" }); await functions.read({ path: "3" })`, host)
    expect(asked).toEqual(['read {"path":"1"}', 'read {"path":"2"}', 'read {"path":"3"}'])
  })

  test("a failed call rejects with the tool's output and status, and the program can catch it", async () => {
    const { host } = recording(() => ({ status: "error", output: "no matches" }))
    const outcome = await run(`try { await grep({ pattern: "x" }) } catch (e) { return [e.name, e.tool, e.status, e.output] }`, host)
    expect(outcome.end).toEqual({ kind: "returned", value: JSON.stringify(["ToolError", "grep", "error", "no matches"], null, 2) })
  })

  test("a syntax error, an exception and an uncaught failed call say the program's own line", async () => {
    const { host } = recording(() => ({ status: "error", output: "File not found" }))
    const syntax = await run(`const a = 1\nconst b = (\nreturn a`, host)
    expect(syntax.end).toMatchObject({ kind: "threw", error: { kind: "syntax", line: 3 } })
    const thrown = await run(`const a = 1\nnull.foo`, host)
    expect(thrown.end).toMatchObject({ kind: "threw", error: { kind: "runtime", name: "TypeError", line: 2 } })
    const failed = await run(`const a = 1\n\nawait read({ path: "x" })`, host)
    expect(failed.end).toMatchObject({ kind: "threw", error: { kind: "tool", tool: "read", status: "error", message: "File not found", line: 3 } })
  })

  test("a tool it is not given and a call past the limit never reach the host", async () => {
    const { asked, host } = recording()
    const outcome = await run(`const out = []\nfor (let i = 0; i < 3; i++) out.push(await read({ path: String(i) }).catch((e) => e.status))\nreturn out`, host, { limits: { calls: 2 } })
    expect(asked).toHaveLength(2)
    expect(outcome.end).toEqual({ kind: "returned", value: JSON.stringify(['read({"path":"0"})', 'read({"path":"1"})', "not_started"], null, 2) })
    expect(outcome.refusedCalls).toBe(1)
  })

  test("its own time is limited, not the time its calls take", async () => {
    // The call takes twice the limit. The program's own time includes its process starting, which takes most of a
    // second on a loaded runner, so the limit leaves room for that and the call is what would go over it.
    const slow: ProgramHost = { call: async () => (await Bun.sleep(3000), { status: "success", output: "ok" }) }
    const waited = await run(`await read({ path: "a" })\nreturn "done"`, slow, { limits: { ownTimeMs: 1500 } })
    expect(waited.end).toEqual({ kind: "returned", value: "done" })
    const spun = await run(`while (true) {}`, slow, { limits: { ownTimeMs: 1500 } })
    expect(spun.end).toEqual({ kind: "limit", limit: "time" })
  })

  test.if(process.platform === "linux")("its memory is limited", async () => {
    const { host } = recording()
    const outcome = await run(`const keep = []\nwhile (true) keep.push(new Array(1e6).fill(Math.random()))`, host, { limits: { memoryBytes: 150 * 1024 * 1024 } })
    expect(outcome.end).toEqual({ kind: "limit", limit: "memory" })
  })

  test("a stop ends the program, and it resolves only once every call that reached the host has its result", async () => {
    const controller = new AbortController()
    let finished = false
    let reached: () => void = () => {}
    const reachedHost = new Promise<void>((resolve) => (reached = resolve))
    // The call reaches the host, the stop comes, and the call's result arrives a moment after the stop.
    const host: ProgramHost = {
      call: async () => {
        reached()
        await new Promise((resolve) => controller.signal.addEventListener("abort", () => setTimeout(resolve, 200), { once: true }))
        finished = true
        return { status: "success", output: "late" }
      },
    }
    const running = run(`await read({ path: "a" })`, host, { signal: controller.signal })
    await reachedHost
    controller.abort()
    const outcome = await running
    expect(outcome.end).toEqual({ kind: "stopped" })
    expect(finished).toBe(true)
  })

  test("printed text past the limit is counted and dropped", async () => {
    const { host } = recording()
    const outcome = await run(`for (let i = 0; i < 100; i++) console.log("x".repeat(99))`, host, { limits: { printBytes: 1000 } })
    expect(outcome.printed.length).toBe(1000)
    expect(outcome.droppedBytes).toBe(9000)
  })
})

describe("the text the model is shown", () => {
  const limits = PROGRAM_LIMITS
  const outcome = (end: Parameters<typeof renderOutcome>[0]["end"], printed = "", calls = 0) => ({ end, printed, droppedBytes: 0, calls, refusedCalls: 0, durationMs: 1 })
  test("for each way a program ends", () => {
    expect(renderOutcome(outcome({ kind: "returned", value: null }), limits, null).output).toBe("The program finished; it printed nothing and returned nothing.")
    expect(renderOutcome(outcome({ kind: "returned", value: "3" }, "a\n"), limits, null)).toMatchObject({ status: "success", output: "a\n3" })
    expect(renderOutcome(outcome({ kind: "threw", error: { kind: "runtime", name: "TypeError", message: "x is undefined", line: 4, column: null } }, "", 2), limits, null).output).toBe(
      "The program stopped: it threw TypeError (line 4): x is undefined\n2 tool calls had run before that; what they did stays.",
    )
    expect(renderOutcome(outcome({ kind: "limit", limit: "time" }), limits, null).output).toBe("The program was ended: it ran for more than 60 s of its own time (time waiting for calls not counted).\nNo tool call had run.")
    expect(renderOutcome(outcome({ kind: "stopped" }, "", 1), limits, "call").output).toBe("[Stopped by the user. The program was ended. 1 tool call had run before that; what they did stays.]")
  })

  test("the spec is a constant, whatever the session has", () => {
    expect(CODE_TOOL_SPEC.description).toContain("mcp_search and mcp_call")
    expect(JSON.stringify(CODE_TOOL_SPEC)).not.toContain(process.cwd())
  })
})

const sandbox = createCommandSandbox()
describe.if(sandbox.state.available)("under the sandbox", () => {
  const confine: Confine = (input) => {
    const plan = sandbox.confined!({ cwd: input.root, root: input.root, argv: input.argv, env: input.env })
    return plan.kind === "ready" ? plan : { refused: plan.reason }
  }
  test("it can write nothing but its own directory and reach no network; its calls still work", async () => {
    const { host } = recording()
    // A path in a directory the process can see as it is (the machine's /tmp is not: under bubblewrap /tmp is the run's own).
    const target = join(process.cwd(), `.codemode-probe-${process.pid}`)
    const outcome = await run(
      `const fs = require("node:fs")\nconst wrote = (() => { try { fs.writeFileSync(${JSON.stringify(target)}, "x"); return "wrote" } catch (e) { return e.code } })()\nconst net = await fetch("http://example.com").then(() => "reached", () => "no network")\nreturn [wrote, net, await read({ path: "a" })]`,
      host,
      { confine },
    )
    // Bubblewrap mounts what it may not write read-only (EROFS); Seatbelt (macOS) refuses the write itself (EPERM).
    const refused = process.platform === "darwin" ? "EPERM" : "EROFS"
    expect(outcome.end).toEqual({ kind: "returned", value: JSON.stringify([refused, "no network", 'read({"path":"a"})'], null, 2) })
    expect(existsSync(target)).toBe(false)
  })
})

describe("read in a program", () => {
  test("resolves with the file's own lines: the numbers the tool adds are taken off, its note about more lines stays", async () => {
    const numbered = "  9\tconst a = 1\n 10\t\n 11\t  // TODO: x\n\n[Showing lines 9-11 of 40. Call read with offset 12 to continue.]"
    const { host } = recording(() => ({ status: "success", output: numbered }))
    const outcome = await run(`return await read({ path: "a" })`, host)
    expect(outcome.end).toEqual({ kind: "returned", value: "const a = 1\n\n  // TODO: x\n\n[Showing lines 9-11 of 40. Call read with offset 12 to continue.]" })
  })

  test("ends with a line break where the file does, as read's display says", async () => {
    const whole = (endsWithNewline: boolean) => recording(() => ({ status: "success", output: "1\ta\n2\tb", display: { endsWithNewline } })).host
    expect((await run(`return JSON.stringify(await read({ path: "a" }))`, whole(true))).end).toEqual({ kind: "returned", value: JSON.stringify("a\nb\n") })
    expect((await run(`return JSON.stringify(await read({ path: "a" }))`, whole(false))).end).toEqual({ kind: "returned", value: JSON.stringify("a\nb") })
  })
})

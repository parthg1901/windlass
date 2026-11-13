import { describe, expect, test } from "bun:test"
import { CallSchedule, type Footprint, conflicts, footprintOf, overlaps } from "../../src/schedule/schedule.ts"

const key = (lexical: string, real: string | null = lexical) => ({ lexical, real })
const files = (...paths: string[]): Footprint => ({ kind: "files", paths: paths.map((path) => key(path)) })
const COMMAND: Footprint = { kind: "command" }
const NONE: Footprint = { kind: "none" }
const UNKNOWN: Footprint = { kind: "unknown" }

describe("what a call can disturb", () => {
  test("by its class, where it comes from, and the paths it names", () => {
    const base = { origin: "builtin" as const, delegates: false, paths: [key("/w/a.ts")] }
    expect(footprintOf({ ...base, effect: "read" }).kind).toBe("none")
    expect(footprintOf({ ...base, effect: undefined }).kind).toBe("none")
    expect(footprintOf({ ...base, effect: "exec", delegates: true }).kind).toBe("none")
    expect(footprintOf({ ...base, effect: "network" }).kind).toBe("none")
    expect(footprintOf({ ...base, effect: "exec" }).kind).toBe("command")
    // An MCP server's tool runs outside the sandbox, whatever it says it does.
    expect(footprintOf({ ...base, effect: "network", origin: "mcp" }).kind).toBe("command")
    expect(footprintOf({ ...base, effect: "write" })).toEqual({ kind: "files", paths: [key("/w/a.ts")] })
    expect(footprintOf({ ...base, effect: "write", paths: [] }).kind).toBe("unknown")
  })
})

describe("which calls conflict", () => {
  test("paths: the same file, a file inside a directory, by either spelling; a path that could not be resolved meets every path", () => {
    expect(overlaps(key("/w/a.ts"), key("/w/a.ts"))).toBe(true)
    expect(overlaps(key("/w/src"), key("/w/src/a.ts"))).toBe(true)
    expect(overlaps(key("/w/src/a.ts"), key("/w/src"))).toBe(true)
    expect(overlaps(key("/w/a.ts"), key("/w/b.ts"))).toBe(false)
    expect(overlaps(key("/w/src"), key("/w/src2/a.ts"))).toBe(false)
    // A link: two names of one file.
    expect(overlaps(key("/w/link/a.ts", "/w/real/a.ts"), key("/w/real/a.ts"))).toBe(true)
    expect(overlaps(key("/w/a.ts", null), key("/elsewhere"))).toBe(true)
  })

  test("by footprint", () => {
    expect(conflicts(files("/w/a.ts"), files("/w/b.ts"))).toBe(false)
    expect(conflicts(files("/w/a.ts"), files("/w/a.ts"))).toBe(true)
    expect(conflicts(COMMAND, COMMAND)).toBe(false)
    expect(conflicts(COMMAND, files("/w/a.ts"))).toBe(true)
    expect(conflicts(files("/w/a.ts"), COMMAND)).toBe(true)
    expect(conflicts(UNKNOWN, files("/w/a.ts"))).toBe(true)
    expect(conflicts(UNKNOWN, UNKNOWN)).toBe(true)
    expect(conflicts(UNKNOWN, COMMAND)).toBe(true)
    for (const other of [NONE, COMMAND, UNKNOWN, files("/w/a.ts")]) expect(conflicts(NONE, other)).toBe(false)
  })
})

describe("the schedule of one response", () => {
  /** A call that records when it starts and ends, and ends when the test says. */
  function harness() {
    const log: string[] = []
    const releases = new Map<string, () => void>()
    const schedule = new CallSchedule()
    const add = (name: string, footprint: Footprint) =>
      schedule.add(
        footprint,
        (waited) => {
          log.push(`start ${name}${waited ? " (waited)" : ""}`)
          return new Promise<void>((resolve) => releases.set(name, resolve)).then(() => void log.push(`end ${name}`))
        },
        () => log.push(`wait ${name}`),
      )
    const finish = async (name: string) => {
      releases.get(name)!()
      // Let everything that waited for it start.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
    }
    return { log, add, finish }
  }

  test("a call with nothing in its way starts at once, synchronously, in the order added", () => {
    const { log, add } = harness()
    void add("read", NONE)
    void add("a", files("/w/a.ts"))
    void add("b", files("/w/b.ts"))
    void add("test", COMMAND)
    void add("lint", COMMAND)
    expect(log).toEqual(["start read", "start a", "start b", "wait test", "wait lint"])
  })

  test("a write waits for an earlier write of the same file, and a command for every write before it", async () => {
    const { log, add, finish } = harness()
    void add("a", files("/w/a.ts"))
    void add("b", files("/w/b.ts"))
    void add("a again", files("/w/a.ts"))
    void add("test", COMMAND)
    void add("c after", files("/w/c.ts"))
    expect(log).toEqual(["start a", "start b", "wait a again", "wait test", "wait c after"])
    await finish("a")
    expect(log.slice(5)).toEqual(["end a", "start a again (waited)"])
    await finish("b")
    await finish("a again")
    expect(log.slice(7)).toEqual(["end b", "end a again", "start test (waited)"])
    // The write after the command waits for it, though it names another file.
    await finish("test")
    expect(log.slice(10)).toEqual(["end test", "start c after (waited)"])
  })

  test("a call that fails is done all the same: what waits for it starts", async () => {
    const schedule = new CallSchedule()
    const started: string[] = []
    void schedule.add(files("/w/a.ts"), () => Promise.reject(new Error("broken")))
    await schedule.add(files("/w/a.ts"), async () => void started.push("second"))
    expect(started).toEqual(["second"])
  })
})

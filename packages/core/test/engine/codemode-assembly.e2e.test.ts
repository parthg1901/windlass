/**
 * Code mode in the real assembly: the real approval layer, the machine's own
 * sandbox and the real tools. The program's process runs confined, its calls
 * are decided and run like direct ones, and it can change nothing itself.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { SETTINGS, USAGE, call, closeHarnesses, place, removePlaces, say, start } from "./assembly-helpers.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

const available = createCommandSandbox().state.available

describe.if(available)("a program in the real harness", () => {
  test("runs confined under mode auto: its write goes through the write tool, its own write is refused", async () => {
    const { data, workspace } = place("wl-codemode-")
    const cwd = workspace("proj", { "a.txt": "one\n" })
    const program = `const own = await (async () => { try { require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "own.txt"))}, "x"); return "wrote" } catch (e) { return e.code } })()\nconst text = await read({ path: "a.txt" })\nawait write({ path: "b.txt", content: "two\\n" })\nreturn [own, text.trim()]`
    const { harness } = start(data, [[call("run_code", { code: program }), USAGE(100)], say("Done.")], { engine: { approval: { user: { mode: "auto" } } } })
    const session = harness.engine.createSession({ cwd, settings: SETTINGS })
    session.send("Copy it.")
    await session.settled()
    const events = session.readEvents()
    const result = events.find((item) => item.type === "tool.settled" && item.data.callId === "call_1")
    expect(result?.type === "tool.settled" ? result.data.outcome : null).toBe("success")
    const [own, text] = result?.type === "tool.settled" ? (JSON.parse(result.data.output) as string[]) : []
    // The workspace is read-only to it, or (a workspace under the machine's /tmp, which bubblewrap replaces with the run's own) not there at all.
    // Seatbelt (macOS) refuses the write itself: EPERM.
    expect(process.platform === "darwin" ? ["EPERM"] : ["EROFS", "ENOENT"]).toContain(own!)
    expect(text).toBe("one")
    const started = events.find((item) => item.type === "tool.started" && item.data.callId === "call_1")
    expect(started?.type === "tool.started" ? started.data.run?.sandbox : undefined).toEqual({ network: false, writableRoots: [] })
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("two\n")
    expect(existsSync(join(cwd, "own.txt"))).toBe(false)
    expect(events.filter((item) => item.type === "tool.called").map((item) => (item.type === "tool.called" ? `${item.data.name}${item.data.parent === undefined ? "" : " <"}` : ""))).toEqual(["run_code", "read <", "write <"])
  })
})

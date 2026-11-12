/**
 * Language-server diagnostics through the loop, with the module's scripted
 * server as a real child process and the scripted provider as the model: a
 * read shows the file to the server, an edit that makes something worse gets
 * a note after its own output (after the hooks' notes), what the servers
 * said is recorded with the result, a server that never answers costs at
 * most the bound, a project's server waits for the user's approval, and
 * closing the engine stops every server.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { LspSetup } from "../../src/engine/lsp.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { fixture, readPid, waitFor } from "../lsp/helpers.ts"
import { measured } from "../scenarios/script.ts"
import { isRunning } from "../tools/helpers.ts"
import { Harness, type HarnessOptions, type ToolBehaviour, failed, removeHarnessDirectories } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
/** Quick registries: a short grace period and a short backoff. */
const QUICK: LspSetup = { graceMs: 300, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 } }

/** A file with a pre-existing warning and error; the edit adds one error. */
const BEFORE = ["let unused = WARN(unused)", "call(ERROR(old))", "end"].join("\n")
const AFTER = ["// a line added above", "let unused = WARN(unused)", "call(ERROR(old))", "fresh(ERROR(fetchUser))", "end"].join("\n")
const NOTE = [
  `[Diagnostics from the language server "fixture" for src/a.txt after this edit: 1 new error]`,
  "src/a.txt:4:7: error E1: cannot find name 'fetchUser' (fixture)",
  "These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.",
].join("\n")

function project(files: Record<string, string> = { "src/a.txt": BEFORE }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-engine-lsp-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  return { root, cwd, pidFile: join(root, "server.pid") }
}

/** The file tools on the real directory: a read returns the file, a write replaces it. */
const reads = (cwd: string): ToolBehaviour => (input) => readFileSync(join(cwd, String(input.path)), "utf8")
const writes = (cwd: string, before: () => Promise<void> = async () => {}): ToolBehaviour => async (input) => {
  await before()
  writeFileSync(join(cwd, String(input.path)), String(input.content))
  return `Wrote ${String(input.path)}.`
}

const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const said = (h: Harness, kind: string) => h.diagnostics.filter((item) => item.kind === kind).map((item) => item.message)
const serverReady = (h: Harness) => () => waitFor(() => h.session.lsp()?.servers.some((server) => server.state === "ready") ?? false, 15_000, "the language server to start")

function harness(cwd: string, config: { user?: ConfigFile; project?: ConfigFile }, more: HarnessOptions = {}) {
  return new Harness({ cwd, userConfig: { verify: { mode: "off" }, ...config.user }, ...(config.project === undefined ? {} : { config: config.project }), lsp: QUICK, ...more })
}

describe("an edit of a file a server serves", () => {
  test("a read shows the file to the server, and the edit's result carries what the edit made worse", async () => {
    const { cwd } = project()
    const h = harness(cwd, { user: { lsp: { waitMs: 5000, servers: { fixture: fixture() } } } })
    h.provider.enqueue([call("read", { path: "src/a.txt" }), U], [call("write", { path: "src/a.txt", content: AFTER }), U], answer("Added the call."))
    // The read started the server; the write waits until it is up, as a model's next step would be seconds later.
    h.tools.on("read", reads(cwd)).on("write", writes(cwd, serverReady(h)))
    h.create().send("Call fetchUser.")
    await h.settled()
    const settled = of(h, "tool.settled")
    expect(settled[0]!.data).toMatchObject({ outcome: "success", output: BEFORE })
    expect(settled[0]!.data.diagnostics).toBeUndefined()
    // The tool's own output first, byte for byte; then a blank line and the note.
    expect(settled[1]!.data.output).toBe(`Wrote src/a.txt.\n\n${NOTE}`)
    const said$ = settled[1]!.data.diagnostics!
    expect(said$).toMatchObject({ noteAdded: true, listed: 1, omitted: 0, servers: [{ name: "fixture", origin: "user", outcome: "compared", new: 1, preExisting: 1, fixed: 0 }] })
    expect(said$.servers[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(said$.waitedMs).toBeLessThanOrEqual(5000 + 400)
    expect(said$.untrusted).toBeUndefined()
    // The model reads the note in the result, and nothing about language servers is in the prefix.
    expect(JSON.stringify(h.provider.requests[2]!.input)).toContain("cannot find name 'fetchUser'")
    expect(h.provider.prefixBreaks()).toEqual([])
    for (const request of h.provider.requests) expect(request.tools).toEqual(h.provider.requests[0]!.tools)
    expect(JSON.stringify(h.provider.requests[0])).not.toContain("fixture")
    expect(h.diagnostics).toEqual([])
    h.verify()
    await h.dispose()
  }, 60_000)

  test("an edit that makes nothing worse, a failed edit and a file no server serves add nothing", async () => {
    const { cwd } = project({ "src/a.txt": BEFORE, "notes.md": "x" })
    const h = harness(cwd, { user: { lsp: { waitMs: 5000, servers: { fixture: fixture() } } } })
    h.provider.enqueue(
      [call("read", { path: "src/a.txt" }), U],
      [call("write", { path: "src/a.txt", content: BEFORE.replace("ERROR(old)", "old") }), U],
      [call("write", { path: "src/a.txt", content: "never written" }), U],
      [call("write", { path: "notes.md", content: "ERROR(x)" }), U],
      answer("Done."),
    )
    h.tools.on("read", reads(cwd)).on("write", writes(cwd, serverReady(h)), () => failed("The file changed on disk since it was read."), writes(cwd))
    h.create().send("Fix the error.")
    await h.settled()
    const settled = of(h, "tool.settled")
    // Fixed one, added none: the record says so and the output is the tool's own.
    expect(settled[1]!.data.output).toBe("Wrote src/a.txt.")
    expect(settled[1]!.data.diagnostics).toMatchObject({ noteAdded: false, listed: 0, servers: [{ outcome: "compared", new: 0, fixed: 1 }] })
    expect(settled[2]!.data).toMatchObject({ outcome: "error", output: "The file changed on disk since it was read." })
    expect(settled[2]!.data.diagnostics).toBeUndefined()
    expect(settled[3]!.data.output).toBe("Wrote notes.md.")
    expect(settled[3]!.data.diagnostics).toBeUndefined()
    h.verify()
    await h.dispose()
  }, 60_000)

  test("the hooks' notes come first, and the diagnostics are of the file as the hooks left it", async () => {
    const { cwd } = project()
    // The after hook is a formatter that rewrites the file: what it leaves has the error on another line.
    const formatted = AFTER.replace("// a line added above\n", "// a line added above\n// formatted\n")
    const scripted = scriptedRunner({
      format: () => {
        writeFileSync(join(cwd, "src/a.txt"), formatted)
        return exited(2, "Reformatted src/a.txt.\n")
      },
    })
    const h = harness(cwd, { user: { lsp: { waitMs: 5000, servers: { fixture: fixture() } }, hooks: { afterTool: [{ name: "format", tools: ["write"], command: "format" }] } } }, { hooks: { runner: scripted.runner } })
    h.provider.enqueue([call("read", { path: "src/a.txt" }), U], [call("write", { path: "src/a.txt", content: AFTER }), U], answer("Added the call."))
    h.tools.on("read", reads(cwd)).on("write", writes(cwd, serverReady(h)))
    h.create().send("Call fetchUser.")
    await h.settled()
    expect(of(h, "tool.settled")[1]!.data.output).toBe(
      ['Wrote src/a.txt.', "", '[Note from the hook "format"]', "Reformatted src/a.txt.", "", NOTE.replace("src/a.txt:4:7", "src/a.txt:5:7")].join("\n"),
    )
    // The hook's record, then the result with the servers' record: one append.
    const log = h.log().map((item) => item.type)
    expect(log.slice(log.lastIndexOf("hook.ran"), log.lastIndexOf("hook.ran") + 2)).toEqual(["hook.ran", "tool.settled"])
    h.verify()
    await h.dispose()
  }, 60_000)
})

describe("the bound", () => {
  test("a server that never answers costs an edit at most the configured wait, adds nothing, and the user is told why once", async () => {
    const { cwd } = project()
    const h = harness(cwd, { user: { lsp: { waitMs: 300, servers: { fixture: fixture(["--silent"], { startupTimeoutSeconds: 1 }) } } } })
    h.provider.enqueue([call("write", { path: "src/a.txt", content: AFTER }), U], [call("write", { path: "src/a.txt", content: BEFORE }), U], answer("Done."))
    const times: number[] = []
    h.tools.on("write", async (input, context) => {
      const out = await writes(cwd)(input, context)
      times.push(performance.now())
      return out
    }, writes(cwd))
    h.create()
    const settledAt: number[] = []
    h.session.subscribe((item) => {
      if (item.type === "tool.settled") settledAt.push(performance.now())
    })
    h.session.send("Edit the file.")
    await h.settled()
    const settled = of(h, "tool.settled")
    expect(settled.map((item) => item.data.output)).toEqual(["Wrote src/a.txt.", "Wrote src/a.txt."])
    // From the moment the tool finished to the stored result: the bound, and slack for a loaded machine.
    expect(settledAt[0]! - times[0]!).toBeLessThan(300 + 600)
    expect(settled[0]!.data.diagnostics).toMatchObject({ noteAdded: false, servers: [{ name: "fixture", outcome: "timeout", new: 0 }] })
    expect(settled[0]!.data.diagnostics!.waitedMs).toBeLessThan(300 + 600)
    expect(said(h, "lsp")).toHaveLength(1)
    expect(said(h, "lsp")[0]).toContain('The language server "fixture"')
    h.verify()
    await h.dispose()
  }, 60_000)
})

describe("a project's server", () => {
  const sandbox: CommandSandbox = {
    state: { available: true },
    temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
    plan: () => {
      throw new Error("a scripted tool spawns nothing")
    },
    policy: () => {
      throw new Error("a scripted tool spawns nothing")
    },
  }
  const approval = (more: Partial<ApprovalSetup> = {}): ApprovalSetup => ({ sandbox, secrets: [], home: "/home/user", ...more })

  test("is not started until the user approved it; then its note is a taint source where the repository is marked untrusted", async () => {
    const { cwd, pidFile } = project()
    // The user marked the whole repository untrusted (their own setting, here as the process's).
    const h = harness(cwd, { project: { lsp: { waitMs: 5000, servers: { fixture: fixture(["--pid-file", pidFile]) } } } }, { approval: approval({ user: { mode: "full", untrustedPaths: ["**"] } }) })
    h.provider.enqueue([call("write", { path: "src/a.txt", content: BEFORE }), U], answer("Unchanged."), [call("write", { path: "src/b.txt", content: "x" }), U], [call("write", { path: "src/b.txt", content: "ERROR(y)" }), U], answer("Added."))
    h.tools.on("write", writes(cwd), writes(cwd), writes(cwd, serverReady(h)))
    h.create()
    const waiting = h.session.lsp()!.awaiting
    expect(waiting).toMatchObject([{ name: "fixture" }])
    expect(waiting[0]!.details.join("\n")).toContain('This project\'s configuration names the language server "fixture"')
    h.session.send("Rewrite the file.")
    await h.settled()
    // Nothing started, nothing added; the record and the user say why, and the model is told nothing.
    expect(() => readPid(pidFile)).toThrow()
    expect(of(h, "tool.settled")[0]!.data).toMatchObject({ output: "Wrote src/a.txt.", diagnostics: { noteAdded: false, servers: [{ name: "fixture", origin: "project", outcome: "not_approved" }] } })
    expect(said(h, "lsp").join("\n")).toContain('This project\'s configuration names the language server "fixture"')
    expect(h.session.approveLspServer("fixture", "0000000000000000")).toBe(false)
    expect(h.session.approveLspServer("fixture", waiting[0]!.fingerprint)).toBe(true)
    expect(h.session.lsp()!.awaiting).toEqual([])
    h.session.send("Add an error to b.")
    await h.settled()
    const last = of(h, "tool.settled").at(-1)!
    expect(last.data.output).toContain(`[Diagnostics from the language server "fixture" for src/b.txt after this edit: 1 new error]`)
    expect(last.data.diagnostics).toMatchObject({ noteAdded: true, untrusted: true, servers: [{ origin: "project", outcome: "compared", new: 1 }] })
    // The project chose that program and its messages, in a repository the user marked untrusted: a source, said once.
    const noticed = of(h, "taint.noticed")
    expect(noticed).toHaveLength(1)
    expect(noticed[0]!.data.source).toMatchObject({ tool: "fixture", kind: "lsp-untrusted-project", at: last.seq })
    // Closing the engine stops the server and its process group.
    const pid = readPid(pidFile)
    expect(isRunning(pid)).toBe(true)
    await h.dispose()
    await waitFor(() => !isRunning(pid), 10_000, "the language server to stop")
  }, 60_000)
})

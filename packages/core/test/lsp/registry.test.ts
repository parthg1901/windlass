/**
 * The registry with real child processes, against each scripted server: the
 * bound on waiting, stale publications, floods, crashes and restarts,
 * approval, and that no process outlives a stop or the harness.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { lspApprovalKey, planLspServers } from "../../src/lsp/config.ts"
import { NOTE_LIMITS } from "../../src/lsp/note.ts"
import { isRunning } from "../tools/helpers.ts"
import { cleanup, fixture, make, readLines, readPid, tempDir, waitFor } from "./helpers.ts"

afterEach(cleanup)

/** A file with a pre-existing warning and error; the edit adds one error. */
const BEFORE = ["let unused = WARN(unused)", "call(ERROR(old))", "end"].join("\n")
const AFTER = ["// a line added above", "let unused = WARN(unused)", "call(ERROR(old))", "fresh(ERROR(fetchUser))", "end"].join("\n")
/** Slack for scheduling on a loaded machine, on top of the bound. */
const SLACK_MS = 400

async function ready(made: ReturnType<typeof make>, file = "src/a.txt", text = BEFORE) {
  made.registry.observe(join(made.cwd, file), text)
  await waitFor(() => made.registry.status().some((s) => s.state === "ready"), 10_000, "the server to start")
}

describe("a well-behaved server (push, versioned)", () => {
  test("the note lists only what the edit added, with the pre-existing counted", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made)
    const started = performance.now()
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(performance.now() - started).toBeLessThan(1500 + SLACK_MS)
    expect(result.servers).toMatchObject([{ server: "fixture", outcome: "compared" }])
    expect(result.note).toBe(
      [
        `[Diagnostics from the language server "fixture" for src/a.txt after this edit: 1 new error]`,
        "src/a.txt:4:7: error E1: cannot find name 'fetchUser' (fixture)",
        "These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.",
      ].join("\n"),
    )
    expect(result).toMatchObject({ listed: 1, omitted: 0, skipped: null })
  })

  test("the first edit of a file never seen opens it as it was, then compares", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made, "other.txt", "x")
    const result = await made.registry.diagnose({ path: join(made.cwd, "src/a.txt"), before: BEFORE, after: AFTER })
    expect(result.servers[0]!.comparison).toMatchObject({ preExisting: 1, added: [{ message: "cannot find name 'fetchUser'" }] })
  })

  test("an edit that fixes an error adds no note", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: BEFORE.replace("ERROR(old)", "old") })
    expect(result.note).toBeNull()
    expect(result.servers[0]!.comparison).toMatchObject({ added: [], fixed: 1 })
  })

  test("a new file: every error in it is the edit's", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made, "other.txt", "x")
    const result = await made.registry.diagnose({ path: "new.txt", before: null, after: "ERROR(a)\nERROR(b)" })
    expect(result.listed).toBe(2)
  })

  test("warnings are reported when the configuration asks for them", async () => {
    const made = make({ warnings: true, servers: { fixture: fixture() } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: `${BEFORE}\nWARN(more)` })
    expect(result.note).toContain("1 new warning")
  })

  test("successive edits each compare with the one before", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made)
    await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    const second = await made.registry.diagnose({ path: "src/a.txt", before: AFTER, after: `${AFTER}\nERROR(third)` })
    expect(second.servers[0]!.comparison).toMatchObject({ preExisting: 2, added: [{ message: "cannot find name 'third'" }] })
  })

  test("a file changed behind the server's back (by a command) is resynchronised before the comparison", async () => {
    const made = make({ servers: { fixture: fixture() } })
    await ready(made, "src/a.txt", "stale text")
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(result.servers[0]!.comparison).toMatchObject({ preExisting: 1, added: [{ message: "cannot find name 'fetchUser'" }] })
  })

  test("the server's requests are answered: configuration from settings, registrations, progress; unknown ones refused", async () => {
    const log = join(tempDir(), "log")
    const made = make({ servers: { fixture: fixture(["--ask", "--log", log], { settings: { fixture: { rules: { strict: true } } } }) } })
    await ready(made)
    await waitFor(() => readLines(log).filter((line) => line.startsWith("answer")).length === 4, 5000, "the answers")
    const answers = readLines(log).filter((line) => line.startsWith("answer"))
    expect(answers).toEqual([
      'answer workspace/configuration [{"strict":true},null]',
      "answer client/registerCapability null",
      "answer window/workDoneProgress/create null",
      'answer workspace/unknownThing {"code":-32601,"message":"method not found: workspace/unknownThing"}',
    ])
    expect(readLines(log)[0]).toBe("initialize")
    expect(readLines(log)).toContain("initialized")
  })

  test("documents beyond the limit are closed, least recently used first", async () => {
    const log = join(tempDir(), "log")
    const made = make({ servers: { fixture: fixture(["--log", log]) } }, { maxOpenDocuments: 1 })
    await ready(made, "one.txt", "1")
    made.registry.observe("two.txt", "2")
    await waitFor(() => readLines(log).includes("textDocument/didClose"), 5000, "didClose")
    expect(made.registry.status()[0]!.openDocuments).toBe(1)
  })

  test("one server per workspace root, found by its markers", async () => {
    const cwd = tempDir()
    await Bun.write(join(cwd, "pkg-a", "marker.json"), "{}")
    await Bun.write(join(cwd, "pkg-b", "marker.json"), "{}")
    const made = make({ servers: { fixture: fixture([], { rootMarkers: ["marker.json"] }) } }, { cwd })
    made.registry.observe("pkg-a/src/x.txt", "a")
    made.registry.observe("pkg-b/y.txt", "b")
    made.registry.observe("loose.txt", "c")
    await waitFor(() => made.registry.status().filter((s) => s.state === "ready").length === 3, 10_000, "three servers")
    expect(made.registry.status().map((s) => s.root)).toEqual([cwd, join(cwd, "pkg-a"), join(cwd, "pkg-b")])
  })
})

describe("a pull-only server", () => {
  test("diagnostics come from textDocument/diagnostic, with the same result", async () => {
    const log = join(tempDir(), "log")
    const made = make({ servers: { fixture: fixture(["--pull", "--log", log]) } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(result.listed).toBe(1)
    expect(result.note).toContain("src/a.txt:4:7: error E1: cannot find name 'fetchUser'")
    expect(readLines(log)).toContain("textDocument/diagnostic")
  })
})

describe("a slow server", () => {
  test("no stall: the call returns at the bound with no note, and the user is told once", async () => {
    const made = make({ waitMs: 800, servers: { slow: fixture(["--delay", "3000"]) } })
    await ready(made)
    for (const after of [AFTER, `${AFTER}\nmore`]) {
      const started = performance.now()
      const result = await made.registry.diagnose({ path: "src/a.txt", before: after === AFTER ? BEFORE : AFTER, after })
      expect(performance.now() - started).toBeLessThan(800 + SLACK_MS)
      expect(result.note).toBeNull()
      expect(result.servers[0]!.outcome).toBe("timeout")
    }
    expect(made.notices.filter((notice) => notice.kind === "timeout")).toHaveLength(1)
    expect(made.notices[0]!.message).toContain('"slow" did not give diagnostics within 800 ms')
  })

  test("an interrupt ends the wait at once", async () => {
    const made = make({ servers: { slow: fixture(["--delay", "3000"]) } })
    await ready(made)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = performance.now()
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER, signal: controller.signal })
    expect(performance.now() - started).toBeLessThan(100 + SLACK_MS)
    expect(result.servers[0]!.outcome).toBe("interrupted")
    expect(result.note).toBeNull()
  })

  test("waitMs 0 turns it off: nothing waits, nothing starts", async () => {
    const pidFile = join(tempDir(), "pid")
    const made = make({ waitMs: 0, servers: { fixture: fixture(["--pid-file", pidFile]) } })
    made.registry.observe("a.txt", "x")
    const result = await made.registry.diagnose({ path: "a.txt", before: "x", after: "ERROR(y)" })
    expect(result).toMatchObject({ note: null, skipped: "off", servers: [] })
    await Bun.sleep(300)
    expect(await Bun.file(pidFile).exists()).toBe(false)
  })
})

describe("a server that never answers", () => {
  test("the edit returns at the bound; the server is stopped and gone", async () => {
    const pidFile = join(tempDir(), "pid")
    const made = make({ waitMs: 600, servers: { mute: fixture(["--silent", "--pid-file", pidFile]) } })
    const started = performance.now()
    const result = await made.registry.diagnose({ path: "a.txt", before: "x", after: "ERROR(y)" })
    expect(performance.now() - started).toBeLessThan(600 + SLACK_MS)
    expect(result.servers[0]).toMatchObject({ outcome: "timeout", detail: "the server was still starting" })
    expect(made.notices.map((notice) => notice.kind)).toEqual(["starting"])
    await waitFor(() => Bun.file(pidFile).size > 0)
    const pid = readPid(pidFile)
    expect(isRunning(pid)).toBe(true)
    await made.registry.stop()
    expect(isRunning(pid)).toBe(false)
  })

  test("a start-up timeout fails the start, says why, and backs off", async () => {
    const made = make({ servers: { mute: fixture(["--silent"], { startupTimeoutSeconds: 1 }) } })
    made.registry.observe("a.txt", "x")
    await waitFor(() => made.registry.status()[0]?.state === "retrying", 5000, "the start to fail")
    expect(made.registry.status()[0]!.error).toBe("it did not answer initialize within 1 s")
    expect(made.notices.map((notice) => notice.kind)).toEqual(["start_failed"])
  })
})

describe("a server that publishes stale diagnostics first", () => {
  test("the publication for the old version is ignored; the fresh one is reported", async () => {
    const made = make({ servers: { stale: fixture(["--stale", "--stale-delay", "300"]) } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(result.servers[0]!.outcome).toBe("compared")
    expect(result.note).toContain("cannot find name 'fetchUser'")
  })

  test("and a fix is not hidden by the stale set that still has the error", async () => {
    const made = make({ servers: { stale: fixture(["--stale", "--stale-delay", "300"]) } })
    await ready(made, "src/a.txt", AFTER)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: AFTER, after: AFTER.replace("ERROR(fetchUser)", "fetchUser") })
    expect(result.servers[0]!.comparison).toMatchObject({ added: [], fixed: 1 })
  })
})

describe("a server that crashes on the second change", () => {
  test("the edit returns without waiting out the bound; the user is told; the next edit after the backoff restarts it", async () => {
    const pidFile = join(tempDir(), "pid")
    const made = make({ servers: { flaky: fixture(["--crash-on-change", "2", "--pid-file", pidFile]) } })
    await ready(made)
    const firstPid = readPid(pidFile)
    expect((await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })).listed).toBe(1)
    const started = performance.now()
    const crashed = await made.registry.diagnose({ path: "src/a.txt", before: AFTER, after: `${AFTER}\nERROR(z)` })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(crashed.note).toBeNull()
    expect(crashed.servers[0]!.outcome).toBe("crashed")
    await waitFor(() => made.registry.status()[0]!.state === "retrying", 5000, "the crash to be seen")
    expect(made.registry.status()[0]!.error).toContain("exited with code 3")
    expect(made.registry.status()[0]!.error).toContain("fixture: crashing on purpose")
    expect(made.notices.find((notice) => notice.kind === "crashed")?.message).toContain('The language server "flaky" stopped')
    await waitFor(() => !isRunning(firstPid), 5000, "the old process to be gone")
    // Within the backoff: not running, no wait.
    expect((await made.registry.diagnose({ path: "src/a.txt", before: AFTER, after: `${AFTER}\nx` })).servers[0]!.outcome).toBe("not_running")
    await Bun.sleep(150)
    const again = await made.registry.diagnose({ path: "src/a.txt", before: AFTER, after: `${AFTER}\nERROR(back)` })
    expect(again.servers[0]!.outcome).toBe("compared")
    expect(again.note).toContain("cannot find name 'back'")
    expect(readPid(pidFile)).not.toBe(firstPid)
    expect(made.registry.status()[0]!.restarts).toBe(1)
  })
})

describe("a server that floods", () => {
  test("thousands of new diagnostics: the note stays within its bounds and says how many were left out", async () => {
    const made = make({ servers: { flood: fixture(["--flood", "2000"]) } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(result.servers[0]!.comparison).toMatchObject({ preExisting: 2000 })
    expect(result.servers[0]!.comparison!.added).toHaveLength(2000)
    expect(result.note!.length).toBeLessThanOrEqual(NOTE_LIMITS.maxChars)
    expect(result).toMatchObject({ listed: 10, omitted: 1990 })
    expect(result.note).toContain("2000 new errors")
    expect(result.note).toContain("... and 1990 more new diagnostics not listed.")
  })
})

describe("approval", () => {
  test("an unapproved project server is not started; the user is asked, the model told nothing", async () => {
    const pidFile = join(tempDir(), "pid")
    const made = make(undefined, { project: { servers: { repo: fixture(["--pid-file", pidFile]) } } })
    made.registry.observe("a.txt", "x")
    const result = await made.registry.diagnose({ path: "a.txt", before: "x", after: "ERROR(y)" })
    expect(result.note).toBeNull()
    expect(result.servers).toMatchObject([{ server: "repo", outcome: "not_approved" }])
    expect(made.registry.status()).toEqual([])
    expect(made.registry.awaitingApproval()).toMatchObject([{ name: "repo", subject: `${process.execPath} ${join(import.meta.dir, "fixtures", "server.ts")} --pid-file ${pidFile}` }])
    expect(made.notices).toMatchObject([{ server: "repo", kind: "not_approved" }])
    await Bun.sleep(300)
    expect(await Bun.file(pidFile).exists()).toBe(false)
  })

  test("approved by fingerprint it starts; an edited definition is not started on the old approval", async () => {
    const project = { servers: { repo: fixture() } }
    const key = lspApprovalKey(planLspServers(undefined, project, () => false).servers[0]!)
    const approved = (k: string) => k === key
    const ok = make(undefined, { project, approved })
    await ready(ok)
    expect(ok.registry.awaitingApproval()).toEqual([])

    const pidFile = join(tempDir(), "pid")
    const edited = make(undefined, { project: { servers: { repo: fixture(["--pid-file", pidFile]) } }, approved })
    expect(edited.registry.awaitingApproval()).toHaveLength(1)
    expect((await edited.registry.diagnose({ path: "a.txt", before: "x", after: "ERROR(y)" })).servers[0]!.outcome).toBe("not_approved")
    expect(await Bun.file(pidFile).exists()).toBe(false)
  })
})

describe("what is skipped", () => {
  test("a file outside the working directory starts nothing", async () => {
    const made = make({ servers: { fixture: fixture() } })
    expect(await made.registry.diagnose({ path: "/etc/elsewhere.txt", before: "a", after: "ERROR(b)" })).toMatchObject({ skipped: "outside_workspace", note: null })
    expect(made.registry.status()).toEqual([])
  })

  test("a file no server serves: no note, the user told once per extension", async () => {
    const made = make({ servers: { fixture: fixture() } })
    for (const path of ["a.md", "b.md", "c.json"]) expect((await made.registry.diagnose({ path, before: "a", after: "b" })).skipped).toBe("no_server")
    expect(made.notices.map((notice) => notice.message)).toEqual([
      "No configured language server serves .md files, so edits of them get no diagnostics.",
      "No configured language server serves .json files, so edits of them get no diagnostics.",
    ])
  })

  test("a command that cannot be started fails that server only, saying why", async () => {
    const made = make({ servers: { missing: fixture([], { command: "/nonexistent/language-server" }), fixture: fixture() } })
    await ready(made)
    const result = await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })
    expect(result.servers.map((s) => [s.server, s.outcome])).toEqual([
      ["fixture", "compared"],
      ["missing", "not_running"],
    ])
    expect(result.listed).toBe(1)
    expect(made.notices.find((n) => n.kind === "start_failed")?.message).toContain('"missing" could not be started')
  })
})

describe("no process is left behind", () => {
  test("stop ends the server and what it started, even one that ignores SIGTERM", async () => {
    const dir = tempDir()
    const made = make({ servers: { fixture: fixture(["--stubborn", "--pid-file", join(dir, "pid"), "--grandchild", join(dir, "child")]) } })
    await ready(made)
    await waitFor(() => Bun.file(join(dir, "child")).size > 0)
    const pid = readPid(join(dir, "pid"))
    const child = readPid(join(dir, "child"))
    expect(isRunning(pid)).toBe(true)
    expect(isRunning(child)).toBe(true)
    await made.registry.stop()
    expect(isRunning(pid)).toBe(false)
    await waitFor(() => !isRunning(child), 2000, "the server's child to die with its group")
    expect(made.registry.status()[0]!.state).toBe("stopped")
    // After stop nothing starts again.
    expect((await made.registry.diagnose({ path: "src/a.txt", before: BEFORE, after: AFTER })).skipped).toBe("off")
  })

  test("a polite server gets shutdown and exit", async () => {
    const log = join(tempDir(), "log")
    const made = make({ servers: { fixture: fixture(["--log", log]) } })
    await ready(made)
    await made.registry.stop()
    expect(readLines(log).slice(-2)).toEqual(["shutdown", "exit"])
  })

  test("the harness killed outright: the guard kills the server's process group", async () => {
    const dir = tempDir()
    const host = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "host.ts"), dir, join(dir, "pid"), join(dir, "child")], { stdout: "pipe", stderr: "inherit" })
    try {
      const reader = host.stdout.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value).trim()).toBe("ready")
      const pid = readPid(join(dir, "pid"))
      const child = readPid(join(dir, "child"))
      expect(isRunning(pid)).toBe(true)
      host.kill("SIGKILL")
      await host.exited
      await waitFor(() => !isRunning(pid) && !isRunning(child), 5000, "the server group to die with the host")
    } finally {
      host.kill("SIGKILL")
    }
  })
})

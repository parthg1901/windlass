/** The file store on real temporary directories: every operation, the file format, hand edits, corruption, and several processes at once. */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { type MemoryEntry, parseEntryFile, renderEntryFile } from "../../src/memory/entry.ts"
import { defaultDataDir, memoryPaths, openMemoryStore, projectKey } from "../../src/memory/store.ts"
import { fixture, modelProvenance, save, tempDir, userProvenance } from "./helpers.ts"

describe("layout", () => {
  test("user notes, project notes keyed by the project's real path, and usage live under the data directory", () => {
    const { paths, projectDir, base } = fixture()
    expect(paths.user).toBe(join(base, "data", "memory", "user"))
    expect(paths.project).toBe(join(base, "data", "memory", "projects", projectKey(projectDir)))
    expect(projectKey(projectDir)).toMatch(/^repo-[0-9a-f]{12}$/)
    expect(paths.usage).toBe(join(base, "data", "memory", "usage"))
    expect(defaultDataDir({}, "/home/u")).toBe(`/home/u/.local/share/${brand.directory}`)
    expect(defaultDataDir({ XDG_DATA_HOME: "/x" }, "/home/u")).toBe(`/x/${brand.directory}`)
  })

  test("two projects with the same base name get different directories", () => {
    const base = tempDir()
    expect(projectKey(join(base, "a", "app"))).not.toBe(projectKey(join(base, "b", "app")))
  })

  test("in-repository notes are only where the user opted in, and user notes stay in the data directory", () => {
    const { paths, projectDir, store } = fixture({ inRepository: true })
    expect(paths.project).toBe(join(projectDir, `.${brand.directory}`, "memory"))
    save(store, "The integration tests need Postgres on port 5433.")
    expect(readdirSync(paths.project!).filter((name) => name.endsWith(".md"))).toEqual(["m_0001.md"])
    expect(existsSync(join(paths.project!, "project.json"))).toBe(false)
  })

  test("a session without a project has user notes only", () => {
    const base = tempDir()
    const store = openMemoryStore({ paths: memoryPaths({ dataDir: base, projectDir: null }) })
    expect(() => store.save({ text: "x y z", kind: "fact", scope: "project", status: "active", provenance: userProvenance() })).toThrow("no project")
    expect(store.save({ text: "Prefers terse answers.", kind: "preference", scope: "user", status: "active", provenance: userProvenance() }).outcome).toBe("saved")
  })
})

describe("operations", () => {
  test("save writes one readable file per entry with every provenance field, and load reads it back", () => {
    const { store, paths } = fixture()
    const entry = save(store, "Run `bun run db:up` before the integration tests.", {
      provenance: modelProvenance("ses_7", { seq: 12, quote: 'you need "db:up" first, always' }),
    })
    const file = readFileSync(join(paths.project!, "m_0001.md"), "utf8")
    expect(file).toBe(
      [
        "---",
        "id: m_0001",
        "kind: fact",
        "scope: project",
        "status: active",
        "created: 2026-11-12T09:00:00Z",
        "confirmed: 2026-11-12T09:00:00Z",
        "expires: 90d",
        "author: model",
        "session: ses_7",
        "message: msg_1",
        "call: call_1",
        "seq: 12",
        'quote: "you need \\"db:up\\" first, always"',
        "---",
        "Run `bun run db:up` before the integration tests.",
        "",
      ].join("\n"),
    )
    expect(store.load().entries).toEqual([entry])
    expect(store.get("m_0001")).toEqual(entry)
    expect(JSON.parse(readFileSync(join(paths.project!, "project.json"), "utf8")).project).toBe(store.paths.projectDir)
  })

  test("every entry shape renders and parses back to itself", () => {
    const entries: MemoryEntry[] = [
      {
        id: "m_ab12",
        text: "Line one\nline two",
        kind: "correction",
        scope: "user",
        status: "retracted",
        created: "2026-01-01T00:00:00Z",
        confirmed: "2026-02-01T00:00:00Z",
        expires: { type: "until", date: "2027-01-01" },
        provenance: { author: "model", session: "s:1/2", message: "m 1", call: null, seq: 3, quote: "it's\ttabbed", untrusted: true },
        supersedes: "m_cd34",
        userConfirmed: "2026-01-02T00:00:00Z",
        retracted: { at: "2026-03-01T00:00:00Z", by: "user", reason: 'no longer "true"' },
      },
      { ...baseEntry(), expires: { type: "never" } },
    ]
    for (const entry of entries) expect(parseEntryFile(renderEntryFile(entry), "x.md")).toEqual(entry)
  })

  test("retract keeps the file and records who and why; decide and renew change only what they say", () => {
    const { store, time } = fixture()
    const fact = save(store, "Staging is at staging.internal.example.")
    time.advanceDays(1)
    const retracted = store.retract(fact.id, "model", "the host moved")
    expect(retracted.ok).toBe(true)
    expect(store.get(fact.id)).toMatchObject({ status: "retracted", retracted: { at: "2026-11-13T09:00:00Z", by: "model", reason: "the host moved" } })
    expect(store.retract(fact.id, "user", null)).toEqual({ ok: false, reason: `${fact.id} is already retracted.` })
    expect(store.retract("m_9999", "user", null)).toEqual({ ok: false, reason: "There is no memory note m_9999." })

    const pending = save(store, "The release script needs GPG configured.", { status: "pending", provenance: modelProvenance("ses_2", { untrusted: true }) })
    time.advanceDays(1)
    expect(store.decide(pending.id, "confirm")).toMatchObject({ ok: true, entry: { status: "active", userConfirmed: "2026-11-14T09:00:00Z", confirmed: "2026-11-14T09:00:00Z" } })
    expect(store.decide(pending.id, "reject")).toEqual({ ok: false, reason: `${pending.id} is active, not waiting for confirmation.` })
    const other = save(store, "Docs are built with mkdocs.", { status: "pending", provenance: modelProvenance("ses_2", { untrusted: true }) })
    expect(store.decide(other.id, "reject")).toMatchObject({ ok: true, entry: { status: "rejected" } })

    time.advanceDays(30)
    expect(store.renew(pending.id)).toMatchObject({ ok: true, entry: { confirmed: "2026-12-14T09:00:00Z" } })
    expect(store.renew(other.id).ok).toBe(false)
    // Nothing was deleted.
    expect(store.load().entries.map((entry) => entry.id)).toEqual([fact.id, pending.id, other.id])
  })

  test("supersession: both files stay, the new one names the old one", () => {
    const { store } = fixture()
    const old = save(store, "Tests run with jest.")
    const next = save(store, "Tests run with bun test.", { supersedes: old.id })
    expect(next.supersedes).toBe(old.id)
    expect(store.get(old.id)?.status).toBe("active")
    expect(store.load().entries).toHaveLength(2)
  })

  test("usage records append per session and read back in order; a torn line is reported and skipped", () => {
    const { store, paths } = fixture()
    store.recordUsage({ type: "read", session: "ses/1", at: "2026-11-12T09:00:00Z", query: "db", ids: ["m_0001"] })
    store.recordUsage({ type: "outcome", session: "ses/1", at: "2026-11-12T09:01:00Z", turn: 9, outcome: "passed", entries: null, note: null })
    store.recordUsage({ type: "outcome", session: "ses_2", at: "2026-11-12T09:02:00Z", turn: null, outcome: "interrupted", entries: null, note: null })
    expect(store.usage("ses/1").records.map((record) => record.type)).toEqual(["read", "outcome"])
    expect(store.usage().records).toHaveLength(3)
    expect(() => store.recordUsage({ type: "outcome", session: "s", at: "x", turn: 0, outcome: "passed", entries: null, note: null })).toThrow("turn")
    writeFileSync(join(paths.usage, "ses_2.jsonl"), `${readFileSync(join(paths.usage, "ses_2.jsonl"), "utf8")}{"type":"outc`)
    const read = store.usage("ses_2")
    expect(read.records).toHaveLength(1)
    expect(read.problems).toEqual([{ path: join(paths.usage, "ses_2.jsonl"), line: 2, problem: expect.stringContaining("JSON") }])
  })
})

describe("hand edits", () => {
  test("a person can write an entry with four keys, edit text and expiry, and delete a file", () => {
    const { store, paths } = fixture()
    save(store, "placeholder note to create the directory")
    writeFileSync(join(paths.project!, "m_hand.md"), "---\nid: m_hand\nkind: preference\nscope: project\ncreated: 2026-11-01T10:00:00Z\n---\nKeep PR descriptions under ten lines.\n")
    const hand = store.get("m_hand")!
    expect(hand).toMatchObject({ status: "active", confirmed: "2026-11-01T10:00:00Z", expires: { type: "confirm-within", days: 365 }, provenance: { author: "user" } })
    const path = join(paths.project!, "m_0001.md")
    writeFileSync(path, readFileSync(path, "utf8").replace("expires: 90d", "expires: never").replace("placeholder note to create the directory", "An edited note."))
    expect(store.get("m_0001")).toMatchObject({ text: "An edited note.", expires: { type: "never" } })
    unlinkSync(path)
    expect(store.get("m_0001")).toBeNull()
  })

  test("a file that no longer parses is reported with its line, left untouched, and operations on it are refused", () => {
    const { store, paths } = fixture()
    const kept = save(store, "A note that stays fine.")
    const broken = save(store, "A note someone will break.")
    const path = join(paths.project!, `${broken.id}.md`)
    const edited = readFileSync(path, "utf8").replace("expires: 90d", "expire: never")
    writeFileSync(path, edited)
    const loaded = store.load()
    expect(loaded.entries.map((entry) => entry.id)).toEqual([kept.id])
    expect(loaded.problems).toEqual([{ path, line: 8, problem: 'unknown key "expire"; did you mean "expires"?' }])
    const refused = store.retract(broken.id, "user", null)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain("does not parse, so it was left alone")
    expect(readFileSync(path, "utf8")).toBe(edited)
  })

  test("corrupted files of every kind are reported, never thrown or removed", () => {
    const { store, paths } = fixture()
    save(store, "The one good note.")
    const cases: Record<string, string> = {
      "m_bin1.md": "\u0000\u0001garbage",
      "m_open.md": "---\nid: m_open\nkind: fact\n",
      "m_kind.md": "---\nid: m_kind\nkind: rumour\nscope: project\ncreated: 2026-11-01T00:00:00Z\n---\nx\n",
      "m_time.md": "---\nid: m_time\nkind: fact\nscope: project\ncreated: yesterday\n---\nx\n",
      "m_body.md": "---\nid: m_body\nkind: fact\nscope: project\ncreated: 2026-11-01T00:00:00Z\n---\n\n",
      "m_quot.md": '---\nid: m_quot\nkind: fact\nscope: project\ncreated: 2026-11-01T00:00:00Z\nquote: "unterminated\n---\nx\n',
      "m_dupl.md": "---\nid: m_0001\nkind: fact\nscope: project\ncreated: 2026-11-01T00:00:00Z\n---\nsame id as another file\n",
    }
    for (const [name, text] of Object.entries(cases)) writeFileSync(join(paths.project!, name), text)
    const loaded = store.load()
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["m_0001"])
    const problems = Object.fromEntries(loaded.problems.map((problem) => [problem.path.split("/").at(-1), problem.problem]))
    expect(problems).toEqual({
      "m_bin1.md": 'expected the front matter to start with a line "---"',
      "m_open.md": 'the front matter is not closed with a line "---"',
      "m_kind.md": 'kind: expected one of preference, correction, fact, pointer, got "rumour"',
      "m_time.md": 'created: expected a timestamp such as 2026-11-12T09:14:03Z, got "yesterday"',
      "m_body.md": "the note itself (the text after the front matter) is empty",
      "m_quot.md": 'a value starting with " must be a complete JSON string, got "unterminated',
      "m_dupl.md": expect.stringContaining("has the same id (m_0001) as"),
    })
    for (const [name, text] of Object.entries(cases)) expect(readFileSync(join(paths.project!, name), "utf8")).toBe(text)
  })

  test("the store's own lock and temporary files are never read as entries", () => {
    const { store, paths } = fixture()
    save(store, "One note.")
    writeFileSync(join(paths.project!, ".m_0002.md.123.abc.tmp"), "half a file")
    expect(readdirSync(paths.project!).sort()).toEqual([".lock", ".m_0002.md.123.abc.tmp", "m_0001.md", "project.json"])
    expect(store.load()).toEqual({ entries: [store.get("m_0001")!], problems: [] })
  })
})

describe("several processes at once", () => {
  test("concurrent writers lose nothing, corrupt nothing, and save a note they all write exactly once", async () => {
    const base = tempDir()
    const dataDir = join(base, "data")
    const projectDir = join(base, "repo")
    const shared = "The CI cache key includes the lockfile hash."
    const writers = ["a", "b", "c", "d"].map((label) =>
      Bun.spawn(["bun", join(import.meta.dir, "fixtures", "writer.ts"), dataDir, projectDir, label, "15", shared], { stdout: "pipe", stderr: "pipe" }),
    )
    const outputs = await Promise.all(
      writers.map(async (writer) => {
        const [code, out, err] = await Promise.all([writer.exited, new Response(writer.stdout).text(), new Response(writer.stderr).text()])
        if (code !== 0) throw new Error(err)
        return JSON.parse(out) as { saved: string[]; shared: string; retracted: boolean }
      }),
    )
    const store = openMemoryStore({ paths: memoryPaths({ dataDir, projectDir }) })
    const loaded = store.load()
    expect(loaded.problems).toEqual([])
    expect(loaded.entries).toHaveLength(4 * 15 + 1)
    expect(new Set(loaded.entries.map((entry) => entry.id)).size).toBe(61)
    for (const output of outputs) {
      expect(output.saved).toHaveLength(15)
      expect(output.retracted).toBe(true)
      expect(store.get(output.saved[0]!)?.status).toBe("retracted")
    }
    expect(outputs.map((output) => output.shared).sort()).toEqual(["merged", "merged", "merged", "saved"])
    expect(loaded.entries.filter((entry) => entry.text === shared)).toHaveLength(1)
    expect(store.usage().records).toHaveLength(4)
    // No temporary file was left behind.
    expect(readdirSync(store.paths.project!).filter((name) => name.endsWith(".tmp"))).toEqual([])
  }, 60_000)

  test("a writer that dies holding the lock does not block the next one", async () => {
    const { store, paths } = fixture()
    save(store, "First note.")
    const script = `
      import { Database } from "bun:sqlite"
      const db = new Database(${JSON.stringify(join(paths.project!, ".lock"))})
      db.run("BEGIN EXCLUSIVE")
      console.log("held")
      await Bun.sleep(60_000)
    `
    const holder = Bun.spawn(["bun", "-e", script], { stdout: "pipe" })
    const reader = holder.stdout.getReader()
    await reader.read()
    const blocked = openMemoryStore({ paths, lockTimeoutMs: 100 })
    expect(() => blocked.save({ text: "Second note here.", kind: "fact", scope: "project", status: "active", provenance: modelProvenance() })).toThrow("held the memory lock")
    holder.kill("SIGKILL")
    await holder.exited
    expect(blocked.save({ text: "Second note here.", kind: "fact", scope: "project", status: "active", provenance: modelProvenance() }).outcome).toBe("saved")
  }, 30_000)
})

function baseEntry(): MemoryEntry {
  return {
    id: "m_base",
    text: "x",
    kind: "fact",
    scope: "project",
    status: "active",
    created: "2026-01-01T00:00:00Z",
    confirmed: "2026-01-01T00:00:00Z",
    expires: { type: "confirm-within", days: 90 },
    provenance: { author: "user", session: null, message: null, call: null, seq: null, quote: null, untrusted: false },
    supersedes: null,
    userConfirmed: null,
    retracted: null,
  }
}

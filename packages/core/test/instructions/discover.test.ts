/**
 * Discovery against a temporary directory tree and a fixed clock, and the
 * whole instruction path end to end: discover, set the baseline, change a
 * file and the date, detect, append, build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MessageId } from "../../src/id.ts"
import { MAX_AGENTS_CHARS, defaultConfigDir, discoverSources } from "../../src/instructions/discover.ts"
import { agentsKey, renderUpdate } from "../../src/instructions/source.ts"
import { instructionState, knownAgentsFiles, prepareInstructions } from "../../src/instructions/state.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { comparePrefix } from "../../src/request/prefix.ts"
import { READ, SETTINGS, SHELL, Script, developer } from "../request/session.ts"

let tree: string

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "windlass-instructions-"))
})

afterAll(() => {
  rmSync(tree, { recursive: true, force: true })
})

let cases = 0

/** Creates a fresh directory under the temporary tree and writes the given files into it. */
function layout(files: Record<string, string>) {
  cases += 1
  const base = join(tree, `case-${cases}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true })
    writeFileSync(join(base, path), content)
  }
  return base
}

const noon = () => new Date(2026, 10, 11, 12, 0)

const keys = (sources: readonly { key: string }[]) => sources.map((source) => source.key)

describe("discoverSources", () => {
  test("lists the user-level file, then the files from the repository root down to the working directory, then environment and date", () => {
    const base = layout({
      "config/AGENTS.md": "Be brief.",
      "AGENTS.md": "Above the repository: never read.",
      "repo/.git/HEAD": "ref: refs/heads/main",
      "repo/AGENTS.md": "Use bun.",
      "repo/packages/core/AGENTS.md": "Core has no dependencies.",
      "repo/packages/core/src/index.ts": "",
      "repo/packages/other/AGENTS.md": "Not on the way to the working directory.",
    })
    const cwd = join(base, "repo/packages/core")
    const sources = discoverSources({ cwd, configDir: join(base, "config"), platform: "linux", now: noon })
    expect(sources).toEqual([
      { key: agentsKey(join(base, "config/AGENTS.md")), value: "Be brief." },
      { key: agentsKey(join(base, "repo/AGENTS.md")), value: "Use bun." },
      { key: agentsKey(join(base, "repo/packages/core/AGENTS.md")), value: "Core has no dependencies." },
      { key: "environment", value: `Working directory: ${cwd}\nPlatform: linux\nGit repository: yes` },
      { key: "date", value: "Wednesday, 2026-11-11" },
    ])
  })

  test("without any AGENTS.md there are still the environment and the date", () => {
    const base = layout({ "repo/.git/HEAD": "", "repo/a.ts": "" })
    const sources = discoverSources({ cwd: join(base, "repo"), configDir: join(base, "config"), platform: "darwin", now: noon })
    expect(keys(sources)).toEqual(["environment", "date"])
    expect(sources[0]!.value).toContain("Platform: darwin")
  })

  test("outside a repository only the working directory itself is searched", () => {
    const base = layout({ "AGENTS.md": "Parent rules.", "work/AGENTS.md": "Work rules.", "work/sub/a.ts": "" })
    const cwd = join(base, "work")
    const sources = discoverSources({ cwd, configDir: join(base, "config"), platform: "linux", now: noon, directories: [join(cwd, "sub")] })
    expect(keys(sources)).toEqual([agentsKey(join(cwd, "AGENTS.md")), "environment", "date"])
    expect(sources[1]!.value).toContain("Git repository: no")
  })

  test("a .git file marks a repository root too, as in a linked worktree", () => {
    const base = layout({ "wt/.git": "gitdir: /elsewhere/.git/worktrees/wt", "wt/AGENTS.md": "Rules.", "wt/src/a.ts": "" })
    const sources = discoverSources({ cwd: join(base, "wt/src"), configDir: join(base, "config"), platform: "linux", now: noon })
    expect(keys(sources)).toEqual([agentsKey(join(base, "wt/AGENTS.md")), "environment", "date"])
    expect(sources[1]!.value).toContain("Git repository: yes")
  })

  test("blank files, directories named AGENTS.md and missing files are no sources", () => {
    const base = layout({ "repo/.git/HEAD": "", "repo/AGENTS.md": " \n\n", "repo/sub/AGENTS.md/placeholder": "" })
    const sources = discoverSources({ cwd: join(base, "repo/sub"), configDir: join(base, "config"), platform: "linux", now: noon })
    expect(keys(sources)).toEqual(["environment", "date"])
  })

  test("file content is normalised", () => {
    const base = layout({ "repo/.git/HEAD": "", "repo/AGENTS.md": "﻿Use bun.\r\nNo mocks.\r\n\r\n" })
    const sources = discoverSources({ cwd: join(base, "repo"), configDir: join(base, "config"), platform: "linux", now: noon })
    expect(sources[0]!.value).toBe("Use bun.\nNo mocks.")
  })

  test("further directories add their files, an ancestor always before its descendants", () => {
    const base = layout({
      "repo/.git/HEAD": "",
      "repo/AGENTS.md": "root",
      "repo/a/AGENTS.md": "a",
      "repo/a/b/AGENTS.md": "a/b",
      "repo/z/AGENTS.md": "z",
      "outside/AGENTS.md": "outside",
    })
    const cwd = join(base, "repo")
    const sources = discoverSources({
      cwd,
      configDir: join(base, "config"),
      platform: "linux",
      now: noon,
      directories: [join(cwd, "z"), "a/b", join(base, "outside"), join(cwd, "a/b")],
    })
    expect(sources.map((source) => source.value).slice(0, -2)).toEqual(["root", "a", "z", "a/b"])
  })

  test("known files are read again wherever they are, and a missing one is simply absent", () => {
    const base = layout({ "repo/.git/HEAD": "", "repo/AGENTS.md": "root", "repo/a/AGENTS.md": "a" })
    const cwd = join(base, "repo")
    const input = { cwd, configDir: join(base, "config"), platform: "linux", now: noon }
    const known = [join(cwd, "a/AGENTS.md"), join(cwd, "gone/AGENTS.md"), join(cwd, "AGENTS.md")]
    expect(discoverSources({ ...input, known }).map((source) => source.value).slice(0, -2)).toEqual(["root", "a"])
  })

  test("the user-level file is listed once even when it is also on the way to the working directory", () => {
    const base = layout({ "config/.git/HEAD": "", "config/AGENTS.md": "Both." })
    const sources = discoverSources({ cwd: join(base, "config"), configDir: join(base, "config"), platform: "linux", now: noon })
    expect(keys(sources)).toEqual([agentsKey(join(base, "config/AGENTS.md")), "environment", "date"])
  })

  test("the date is the local date of the injected clock", () => {
    const base = layout({})
    mkdirSync(base, { recursive: true })
    const date = (now: Date) =>
      discoverSources({ cwd: base, configDir: join(base, "config"), platform: "linux", now: () => now }).at(-1)
    expect(date(new Date(2026, 10, 11, 23, 59, 59))).toEqual({ key: "date", value: "Wednesday, 2026-11-11" })
    expect(date(new Date(2026, 10, 12, 0, 0, 0))).toEqual({ key: "date", value: "Thursday, 2026-11-12" })
    expect(date(new Date(2027, 0, 1, 0, 0, 1))).toEqual({ key: "date", value: "Friday, 2027-01-01" })
  })

  test("a very long file is cut once, on a whole character, with a line saying so", () => {
    const base = layout({
      "repo/.git/HEAD": "",
      "repo/AGENTS.md": `${"a".repeat(MAX_AGENTS_CHARS - 1)}\u{1F600}${"b".repeat(100)}`,
    })
    const input = { cwd: join(base, "repo"), configDir: join(base, "config"), platform: "linux", now: noon }
    const value = discoverSources(input)[0]!.value
    expect(value.startsWith("a".repeat(MAX_AGENTS_CHARS - 1))).toBe(true)
    expect(value).not.toContain("b")
    expect(value).not.toMatch(/[\uD800-\uDFFF]/)
    expect(value.endsWith(`[The rest of this file was left out: it is longer than ${MAX_AGENTS_CHARS} characters.]`)).toBe(true)
    expect(discoverSources(input)[0]!.value).toBe(value)
  })

  test("the same tree and clock give the same sources", () => {
    const base = layout({ "repo/.git/HEAD": "", "repo/AGENTS.md": "root", "config/AGENTS.md": "user" })
    const input = { cwd: join(base, "repo"), configDir: join(base, "config"), platform: "linux", now: noon }
    expect(discoverSources(input)).toEqual(discoverSources(input))
  })
})

describe("defaultConfigDir", () => {
  test("follows XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "windlass"))
    expect(defaultConfigDir({}, "/home/u")).toBe(join("/home/u", ".config", "windlass"))
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe(join("/home/u", ".config", "windlass"))
  })
})

describe("discovery, detection and the request together", () => {
  test("a session lives through an edit, a new day, a nested file and a removal without its prefix ever changing", () => {
    const base = layout({
      "config/AGENTS.md": "Be brief.",
      "repo/.git/HEAD": "",
      "repo/AGENTS.md": "Use bun.",
      "repo/packages/core/src/index.ts": "",
    })
    const cwd = join(base, "repo")
    let now = new Date(2026, 10, 11, 9, 0)
    let next = 0
    const s = new Script()
    s.apply({ type: "session.created", v: 1, data: { cwd, title: null, lineage: null, settings: SETTINGS } })

    /** What the step loop does at each step boundary. Returns the texts it appended. */
    const prepare = (directories: readonly string[] = []) => {
      const known = knownAgentsFiles(instructionState(selectModelHistory(s.projection)))
      const sources = discoverSources({ cwd, configDir: join(base, "config"), platform: "linux", now: () => now, directories, known })
      const events = prepareInstructions(s.projection, {
        tools: [SHELL, READ],
        sources,
        newMessageId: () => `ins_${++next}` as MessageId,
      })
      const before = s.projection.baseline === null ? null : s.hashes()
      // History grows only under a running execution, so the loop prepares instructions after it took the claim.
      s.claim()
      s.apply(...events)
      if (before !== null) expect(comparePrefix(before, s.hashes())).toEqual({ extension: true, appended: events.length })
      return events.flatMap((event) => (event.type === "instruction.appended" ? [event.data.text] : []))
    }

    // First step: the baseline is set, with every source in it.
    expect(prepare()).toEqual([])
    const instructions = s.request().instructions
    expect(instructions).toContain(`<instructions path="${join(base, "config/AGENTS.md")}" lines="1">\nBe brief.`)
    expect(instructions).toContain(`<instructions path="${join(cwd, "AGENTS.md")}" lines="1">\nUse bun.`)
    expect(instructions).toContain("Wednesday, 2026-11-11")
    s.user("hello")
    s.step({ parts: [{ call: "call_1" }] })

    // Nothing changed: nothing is appended, step after step.
    expect(prepare()).toEqual([])
    s.step({ parts: [{ text: "Hi." }] })
    s.release()
    expect(prepare()).toEqual([])

    // The project file is edited and midnight passes.
    writeFileSync(join(cwd, "AGENTS.md"), "Use bun.\nNever mock the database.\n")
    now = new Date(2026, 10, 12, 0, 5)
    const changed = prepare()
    expect(changed).toHaveLength(2)
    expect(changed[0]).toContain("was edited. This version replaces everything")
    expect(changed[0]).toContain("Never mock the database.")
    expect(changed[1]).toBe(renderUpdate({ key: "date", value: "Thursday, 2026-11-12" }, "replaced"))
    expect(s.input().slice(-2)).toEqual(changed.map(developer))
    s.user("next")
    s.step({ parts: [{ call: "call_1" }] })
    expect(prepare()).toEqual([])

    // The session starts working in a subdirectory that has its own file: appended once.
    writeFileSync(join(cwd, "packages/core/AGENTS.md"), "Core has no dependencies.")
    const nested = prepare([join(cwd, "packages/core/src")])
    expect(nested).toHaveLength(1)
    expect(nested[0]).toContain("now applies, in addition to the instructions you already have")
    s.step({ parts: [{ text: "Ok." }] })
    // Later boundaries do not name the directory again; the file is known from the log.
    expect(prepare()).toEqual([])

    // The nested file is deleted: withdrawn once.
    unlinkSync(join(cwd, "packages/core/AGENTS.md"))
    const removed = prepare()
    expect(removed).toEqual([
      `The instructions file ${join(cwd, "packages/core/AGENTS.md")} no longer exists. Disregard everything you were given from that file.`,
    ])
    expect(prepare()).toEqual([])

    // Through all of it the baseline in the log never moved.
    expect(s.request().instructions).toBe(instructions)
    expect(s.events.filter((event) => event.type === "baseline.set")).toHaveLength(1)
  })
})

/**
 * Skills through the loop: the `skill` tool is in the frozen tool list from
 * the first baseline, the index is an appended message that follows the
 * files (first index, an edit, a withdrawal), a load returns the file as it
 * is now, and none of it ever breaks the request prefix.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { SUMMARY, measured } from "../scenarios/script.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

/** A real project directory with these skill files, and an empty directory for the user's own. */
function project(skills: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-skills-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  const write = (name: string, content: string) => {
    const path = join(cwd, ".claude", "skills", name, "SKILL.md")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }
  for (const [name, content] of Object.entries(skills)) write(name, content)
  return { cwd, configDir: join(root, "config"), write, remove: (name: string) => rmSync(join(cwd, ".claude", "skills", name), { recursive: true, force: true }) }
}

const skillFile = (name: string, description: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

/** The text of every message of a request that is not a tool call or result, in order, with its role. */
const said = (request: ModelRequest) =>
  request.input.flatMap((item) => (item.type === "message" ? [{ role: item.role, text: item.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") }] : []))
const appended = (h: Harness) => h.log().filter((item): item is StoredEvent<"instruction.appended"> => item.type === "instruction.appended" && item.data.source === "skills")

describe("skills", () => {
  test("the skill tool is in the tool list from the first request, with or without a skill, and the index is a message, never the baseline", async () => {
    const files = project({ release: skillFile("release", "How to cut a release. Use when asked to release.") })
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd })
    try {
      h.provider.enqueue(answer("Hello."))
      h.create().send("Hi.")
      await h.settled()
      const request = h.provider.requests[0]!
      expect(request.tools.map((tool) => tool.name)).toEqual(["history_read", "history_search", "read", "shell", "skill", "write"])
      expect(request.instructions).not.toContain("release")
      // The index comes before the user's message, as a developer message.
      expect(said(request).map((message) => message.role)).toEqual(["developer", "user"])
      expect(said(request)[0]!.text).toStartWith("Skills you can load:\n<skills lines=")
      expect(said(request)[0]!.text).toContain("- release: How to cut a release. Use when asked to release.")
      const [first] = appended(h)
      expect(first!.data.detail).toEqual({ kind: "skills", skills: [{ name: "release", path: join(files.cwd, ".claude", "skills", "release", "SKILL.md") }] })
      expect(h.log().find((item) => item.type === "baseline.set")!.data).toMatchObject({ sources: [{ source: "date" }] })
      expect(h.diagnostics).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }

    // No skill anywhere: the same tool, the same spec, and nothing is said about skills.
    const empty = project()
    const bare = new Harness({ skills: { configDir: empty.configDir }, cwd: empty.cwd })
    try {
      bare.provider.enqueue(answer("Hello."))
      bare.create().send("Hi.")
      await bare.settled()
      expect(bare.provider.requests[0]!.tools).toEqual(h.provider.requests[0]!.tools)
      expect(said(bare.provider.requests[0]!).map((message) => message.role)).toEqual(["user"])
      expect(appended(bare)).toEqual([])
    } finally {
      await bare.dispose()
    }
  })

  test("an engine without skills offers no tool and says nothing", async () => {
    const files = project({ release: skillFile("release", "How to cut a release.") })
    const h = new Harness({ cwd: files.cwd })
    try {
      h.provider.enqueue(answer("Hello."))
      h.create().send("Hi.")
      await h.settled()
      expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toEqual(["history_read", "history_search", "read", "shell", "write"])
      expect(appended(h)).toEqual([])
      expect(h.session.skills()).toBeNull()
    } finally {
      await h.dispose()
    }
  })

  test("a skill added, edited and removed during a session is appended each time, and every request extends the one before", async () => {
    const files = project()
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd })
    try {
      h.tools.on("shell", () => {
        // The model's own command writes a skill: it is in the index at the next boundary.
        files.write("deploy", skillFile("deploy", "How to deploy."))
        return "written"
      })
      h.tools.on("shell", () => {
        // Editing the body changes nothing the index says; editing the description does.
        files.write("deploy", skillFile("deploy", "How to deploy.", "A longer body."))
        return "body edited"
      })
      h.tools.on("shell", () => {
        files.write("deploy", skillFile("deploy", "How to deploy to production, step by step."))
        return "description edited"
      })
      h.tools.on("shell", () => {
        files.remove("deploy")
        return "removed"
      })
      h.provider.enqueue(
        [call("shell", { command: "write the skill" }), U],
        [call("shell", { command: "edit the body" }), U],
        [call("shell", { command: "edit the description" }), U],
        [call("shell", { command: "remove the skill" }), U],
        answer("Done."),
      )
      h.create().send("Set up a deploy skill, then remove it.")
      await h.settled()
      expect(appended(h).map((item) => item.data.text.split("\n")[0])).toEqual([
        "Skills you can load:",
        "The skills have changed. This list replaces the one you were given before:",
        "There are no skills any more. Disregard the list of skills you were given before.",
      ])
      expect(appended(h).map((item) => item.data.fingerprint === null)).toEqual([false, false, true])
      expect(appended(h).at(-1)!.data.detail).toEqual({ kind: "skills", skills: [] })
      // Five requests, each the previous one plus appended items: the tool list and the instructions never moved.
      expect(h.provider.requests).toHaveLength(5)
      expect(h.provider.prefixBreaks()).toEqual([])
      for (const request of h.provider.requests) {
        expect(request.tools).toEqual(h.provider.requests[0]!.tools)
        expect(request.instructions).toBe(h.provider.requests[0]!.instructions)
      }
      // The request after the body edit carries no new message about skills.
      expect(said(h.provider.requests[2]!).filter((message) => message.role === "developer")).toHaveLength(1)
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a skill edited between two turns is appended when the next turn starts", async () => {
    const files = project({ review: skillFile("review", "How to review a change.") })
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd })
    try {
      h.provider.enqueue(answer("One."), answer("Two."), answer("Three."))
      h.create().send("First.")
      await h.settled()
      files.write("review", skillFile("review", "How to review a change before it is merged."))
      h.session.send("Second.")
      await h.settled()
      h.session.send("Third.")
      await h.settled()
      expect(appended(h)).toHaveLength(2)
      expect(said(h.provider.requests[1]!).map((message) => message.role)).toEqual(["developer", "user", "developer", "user"])
      expect(said(h.provider.requests[2]!).map((message) => message.role)).toEqual(["developer", "user", "developer", "user", "user"])
      expect(h.provider.prefixBreaks()).toEqual([])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("the model loads a skill by name and gets the file as it is now; a typo is answered with the names", async () => {
    const files = project({ release: skillFile("release", "How to cut a release.", "1. Tag.\n2. Push the tag.") })
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd })
    try {
      h.provider.enqueue([call("skill", { name: "release" }), U], [call("skill", { name: "relaese" }, "call_2"), U], answer("Done."))
      h.create().send("Cut a release.")
      await h.settled()
      const results = h.log().filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled")
      expect(results[0]!.data).toMatchObject({ outcome: "success", display: { skill: { name: "release" } } })
      expect(results[0]!.data.output).toBe(`<skill name="release" path="${join(files.cwd, ".claude", "skills", "release", "SKILL.md")}">\n1. Tag.\n2. Push the tag.\n</skill>`)
      expect(results[1]!.data).toMatchObject({ outcome: "error", output: 'There is no skill named "relaese". Did you mean "release"? Skills: release.' })
      // A read: no snapshot, no approval, started with its class.
      expect(h.log().filter((item) => item.type === "tool.started").map((item) => item.data.effect)).toEqual(["read", "read"])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a skill that cannot be loaded is said to the user once, and never to the model", async () => {
    const files = project({ good: skillFile("good", "A skill that loads."), broken: "no front matter here\n" })
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd })
    try {
      h.provider.enqueue([call("read", { path: "a.ts" }), U], answer("Done."))
      h.tools.on("read", "export const a = 1")
      h.create().send("Hi.")
      await h.settled()
      const problems = h.diagnostics.filter((diagnostic) => diagnostic.kind === "skills")
      expect(problems).toHaveLength(1)
      expect(problems[0]!.message).toContain(join(files.cwd, ".claude", "skills", "broken", "SKILL.md"))
      expect(problems[0]!.message).toContain("was not loaded")
      // Shown in the session's stream, for a client.
      expect(h.seenEvents.filter((item) => item.type === "diagnostic" && item.kind === "skills")).toHaveLength(1)
      expect(JSON.stringify(h.provider.requests)).not.toContain("broken")
      // What a client lists: the skills and the problems.
      expect(h.session.skills()!.skills.map((skill) => skill.name)).toEqual(["good"])
      expect(h.session.skills()!.problems).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  test("the user's file adds directories and both files can leave a skill out; a project's file cannot add a directory", async () => {
    const files = project({ a: skillFile("a", "Skill a."), b: skillFile("b", "Skill b.") })
    const team = join(dirname(files.cwd), "team")
    mkdirSync(join(team, "c"), { recursive: true })
    writeFileSync(join(team, "c", "SKILL.md"), skillFile("c", "Skill c."))
    const elsewhere = join(dirname(files.cwd), "elsewhere")
    mkdirSync(join(elsewhere, "d"), { recursive: true })
    writeFileSync(join(elsewhere, "d", "SKILL.md"), skillFile("d", "Skill d."))
    const h = new Harness({
      skills: { configDir: files.configDir },
      cwd: files.cwd,
      userConfig: { skills: { paths: [team], disabled: ["a"] } },
      config: { skills: { paths: [elsewhere], disabled: ["b"] } },
    })
    try {
      h.provider.enqueue(answer("Hello."))
      h.create().send("Hi.")
      await h.settled()
      expect(appended(h)[0]!.data.detail).toMatchObject({ skills: [{ name: "c" }] })
    } finally {
      await h.dispose()
    }
  })

  test("after a compaction the tool list is the same and the index is given again, since the new baseline carries none", async () => {
    const files = project({ release: skillFile("release", "How to cut a release.") })
    const h = new Harness({ skills: { configDir: files.configDir }, cwd: files.cwd, contextWindow: 10_000 })
    try {
      h.tools.on("read", "export const a = 1")
      h.provider.enqueue([call("read", { path: "a.ts" }), script.usage(measured(6000))], [script.text(SUMMARY)], answer("Done."))
      h.create().send("Read a.ts.")
      await h.settled()
      const names = h.provider.requests.map((request) => request.tools.map((tool) => tool.name))
      for (const list of names) expect(list).toEqual(names[0]!)
      expect(names[0]).toContain("skill")
      expect(h.log().filter((item) => item.type === "baseline.set")).toHaveLength(2)
      expect(appended(h).map((item) => item.data.text.split("\n")[0])).toEqual(["Skills you can load:", "Skills you can load:"])
      // The request after the compaction has the index once, from the message appended after the new baseline.
      expect(said(h.provider.requests.at(-1)!).filter((message) => message.role === "developer")).toHaveLength(1)
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

/**
 * Instruction state and change detection, against logs folded by the real
 * reducer. No filesystem and no clock: sources are plain values here.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import type { MessageId } from "../../src/id.ts"
import { BASE_SYSTEM_PROMPT, buildBaseline } from "../../src/instructions/baseline.ts"
import {
  type InstructionSource,
  agentsSource,
  dateSource,
  environmentSource,
  fingerprint,
  renderRemoval,
  renderUpdate,
} from "../../src/instructions/source.ts"
import {
  detectInstructionChanges,
  instructionState,
  knownAgentsFiles,
  prepareInstructions,
} from "../../src/instructions/state.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { comparePrefix } from "../../src/request/prefix.ts"
import { READ, SETTINGS, SHELL, Script, developer } from "../request/session.ts"

const userFile = agentsSource("/home/u/.config/windlass/AGENTS.md", "Be brief.")
const rootFile = agentsSource("/repo/AGENTS.md", "Use bun.")
const environment = environmentSource({ cwd: "/repo", platform: "linux", gitRepository: true })
const monday = dateSource(2026, 11, 9)
const tuesday = dateSource(2026, 11, 10)
const initial = [userFile, rootFile, environment, monday]
const tools = [SHELL, READ]

/** A session whose baseline was built from `sources`, with one finished turn. */
function session(sources: readonly InstructionSource[] = initial) {
  const s = new Script().open(buildBaseline({ tools, sources }))
  s.user("hello")
  s.step({ parts: [{ text: "Hi." }] })
  s.release()
  return s
}

let issued = 0

beforeEach(() => {
  issued = 0
})

/** Message IDs `ins_new_1`, `ins_new_2`, ... counted per test. */
function ids() {
  return () => `ins_new_${++issued}` as MessageId
}

const state = (s: Script) => instructionState(selectModelHistory(s.projection))
const detect = (s: Script, sources: readonly InstructionSource[]) => detectInstructionChanges(state(s), sources, ids())

/** Detects, appends what was detected under a running execution (as the loop does), and returns the appended events. */
function sync(s: Script, sources: readonly InstructionSource[]) {
  const events = detect(s, sources)
  s.claim()
  s.apply(...events)
  return events
}

const replace = (sources: readonly InstructionSource[], next: InstructionSource) =>
  sources.map((source) => (source.key === next.key ? next : source))

describe("instructionState", () => {
  test("is empty before the first baseline", () => {
    expect(instructionState({ baseline: null, messages: [] }).size).toBe(0)
  })

  test("the baseline event lists each source with the fingerprint of its value", () => {
    expect(buildBaseline({ tools, sources: initial }).sources).toEqual(
      initial.map((source) => ({ source: source.key, fingerprint: fingerprint(source.value) })),
    )
  })

  test("starts as the sources of the baseline", () => {
    expect([...state(session())]).toEqual(initial.map((source) => [source.key, fingerprint(source.value)]))
  })

  test("a baseline that lists no sources knows none, whatever its text says", () => {
    expect(state(new Script().open()).size).toBe(0)
    const text = buildBaseline({ tools, sources: initial }).instructions
    expect(state(new Script().open({ instructions: text, tools, sources: [] })).size).toBe(0)
  })

  test("follows appended messages: the newest value per source wins, a removal clears it", () => {
    const s = session()
    s.instruction(monday.key, renderUpdate(tuesday, "replaced"), fingerprint(tuesday.value))
    s.instruction(rootFile.key, renderRemoval(rootFile.key), null)
    const current = state(s)
    expect(current.get("date")).toBe(fingerprint(tuesday.value))
    expect(current.get(rootFile.key)).toBeNull()
    expect(current.get(userFile.key)).toBe(fingerprint(userFile.value))
    expect(knownAgentsFiles(current)).toEqual(["/home/u/.config/windlass/AGENTS.md"])
  })

  test("a message counts for its own source only, by its stored fingerprint and never by its text", () => {
    const s = session()
    // The text carries a date section; the event says it is about `skills`.
    s.instruction("skills", `Available skills:\n${renderUpdate(tuesday, "replaced")}`, "skills-v1")
    expect(state(s).get("date")).toBe(fingerprint(monday.value))
    expect(state(s).get("skills")).toBe("skills-v1")
    // The same text with another fingerprint is another value; text that changes under one fingerprint is not.
    s.instruction("skills", `Available skills:\n${renderUpdate(tuesday, "replaced")}`, "skills-v2")
    expect(state(s).get("skills")).toBe("skills-v2")
    s.instruction("skills", "Reworded, same list.", "skills-v2")
    expect(state(s).get("skills")).toBe("skills-v2")
  })

  test("the text format of a section does not matter to the state", () => {
    const s = new Script().open({ ...buildBaseline({ tools, sources: initial }), instructions: "No sections here at all." })
    expect([...state(s)]).toEqual(initial.map((source) => [source.key, fingerprint(source.value)]))
    expect(detect(s, initial)).toEqual([])
  })
})

describe("detectInstructionChanges", () => {
  test("returns nothing when the sources are what the model already has", () => {
    expect(detect(session(), initial)).toEqual([])
    expect(detect(session(), initial.toReversed())).toEqual([])
  })

  test("a date change becomes one short appended message with its text frozen in the event", () => {
    const s = session()
    const events = sync(s, replace(initial, tuesday))
    expect(events).toEqual([
      {
        type: "instruction.appended",
        v: 1,
        data: {
          messageId: "ins_new_1" as MessageId,
          source: "date",
          text: 'The date has changed. This replaces the date you were given before:\n<date lines="1">\nTuesday, 2026-11-10\n</date>',
          fingerprint: fingerprint("Tuesday, 2026-11-10"),
        },
      },
    ])
    expect(detect(s, replace(initial, tuesday))).toEqual([])
  })

  test("an edited AGENTS.md is appended with its new content and says it replaces the earlier one", () => {
    const s = session()
    const edited = agentsSource("/repo/AGENTS.md", "Use bun.\nNever mock the database.")
    const events = sync(s, replace(initial, edited))
    expect(events.map((event) => event.data)).toEqual([
      {
        messageId: "ins_new_1" as MessageId,
        source: "agents:/repo/AGENTS.md",
        text: renderUpdate(edited, "replaced"),
        fingerprint: fingerprint(edited.value),
      },
    ])
    expect(events[0]!.data.text).toContain("replaces everything you were given from that file before")
    expect(events[0]!.data.text).toContain("Never mock the database.")
    expect(detect(s, replace(initial, edited))).toEqual([])
  })

  test("a subdirectory AGENTS.md first seen later is appended once, as an addition", () => {
    const s = session()
    const nested = agentsSource("/repo/packages/core/AGENTS.md", "Core has no dependencies.")
    const sources = [userFile, rootFile, nested, environment, monday]
    const events = sync(s, sources)
    expect(events.map((event) => event.data.text)).toEqual([renderUpdate(nested, "added")])
    expect(events[0]!.data.text).toContain("now applies, in addition to the instructions you already have")
    expect(detect(s, sources)).toEqual([])
    s.user("next")
    s.step({ parts: [{ text: "Ok." }] })
    expect(detect(s, sources)).toEqual([])
  })

  test("a file that no longer exists is withdrawn once, and announced again as an addition if it returns", () => {
    const s = session()
    const without = initial.filter((source) => source.key !== rootFile.key)
    expect(sync(s, without).map((event) => event.data)).toEqual([
      { messageId: "ins_new_1" as MessageId, source: rootFile.key, text: renderRemoval(rootFile.key), fingerprint: null },
    ])
    expect(detect(s, without)).toEqual([])
    expect(sync(s, initial).map((event) => event.data.text)).toEqual([renderUpdate(rootFile, "added")])
  })

  test("a value that changes and then changes back is appended both times", () => {
    const s = session()
    sync(s, replace(initial, tuesday))
    expect(sync(s, initial).map((event) => event.data.text)).toEqual([renderUpdate(monday, "replaced")])
    expect(detect(s, initial)).toEqual([])
  })

  test("several changes come in source order, removals last, one event per source", () => {
    const s = session()
    const nested = agentsSource("/repo/packages/core/AGENTS.md", "Core rules.")
    const moved = environmentSource({ cwd: "/repo", platform: "linux", gitRepository: false })
    const events = detect(s, [nested, moved, tuesday])
    expect(events.map((event) => event.data.source)).toEqual([
      nested.key,
      "environment",
      "date",
      userFile.key,
      rootFile.key,
    ])
    expect(new Set(events.map((event) => event.data.messageId)).size).toBe(5)
  })

  test("the environment and the date are never withdrawn, only replaced", () => {
    expect(detect(session(), [userFile, rootFile])).toEqual([])
  })

  test("a baseline that was not built from sources gets every source as an addition", () => {
    const s = new Script().open()
    expect(detect(s, [rootFile, monday]).map((event) => event.data.text)).toEqual([
      renderUpdate(rootFile, "added"),
      renderUpdate(monday, "added"),
    ])
  })

  test("messages about sources this module does not own are left alone", () => {
    const s = session()
    s.instruction("skills", "Available skills: review, deploy.")
    expect(detect(s, initial)).toEqual([])
  })
})

describe("the state needs no memory besides the log", () => {
  test("a reverted instruction message is detected again", () => {
    const s = session()
    const prompt = s.user("another day")
    sync(s, replace(initial, tuesday))
    s.step({ parts: [{ text: "Ok." }] })
    s.release()
    expect(detect(s, replace(initial, tuesday))).toEqual([])
    s.revert(prompt)
    expect(detect(s, replace(initial, tuesday)).map((event) => event.data.source)).toEqual(["date"])
  })

  test("an instruction message inside a refused range is detected again", () => {
    const s = session()
    const prompt = s.user("refused prompt")
    sync(s, replace(initial, tuesday))
    s.step({ end: { refusedFrom: prompt } })
    s.failExecution()
    expect(detect(s, replace(initial, tuesday)).map((event) => event.data.source)).toEqual(["date"])
  })

  test("a compaction that leaves the change behind the checkpoint, without a new baseline, is detected again", () => {
    const s = session()
    sync(s, replace(initial, tuesday))
    s.user("go on")
    s.step({ parts: [{ text: "Ok." }] })
    s.compact((seq) => seq)
    expect(detect(s, replace(initial, tuesday)).map((event) => event.data.source)).toEqual(["date"])
  })

  test("a new baseline after a compaction folds the change in, and the kept message stops counting", () => {
    const s = session()
    const stale = agentsSource("/repo/AGENTS.md", "An edit that was later undone.")
    const [appended] = sync(s, replace(initial, stale))
    const kept = s.seq
    s.user("go on")
    s.step({ parts: [{ text: "Ok." }] })
    s.compact(() => kept)
    const fresh = replace(initial, tuesday)
    s.apply(...prepareInstructions(s.projection, { tools, sources: fresh, newMessageId: ids() }))
    expect(s.projection.baseline!.seq).toBe(s.seq)
    expect(detect(s, fresh)).toEqual([])
    expect(s.input()).not.toContainEqual(developer(appended!.data.text))
  })

  test("a fork inherits the state of its parent's history", () => {
    const s = session()
    sync(s, replace(initial, tuesday))
    const copy = JSON.parse(JSON.stringify(selectModelHistory(s.projection)))
    expect([...instructionState(copy)]).toEqual([...state(s)])
  })
})

describe("prepareInstructions", () => {
  const input = (sources: readonly InstructionSource[]) => ({ tools, sources, newMessageId: ids() })

  test("sets the baseline when the session has none", () => {
    const s = new Script()
    s.apply({ type: "session.created", v: 1, data: { cwd: "/repo", title: null, lineage: null, settings: SETTINGS } })
    const events = prepareInstructions(s.projection, input(initial))
    expect(events).toEqual([{ type: "baseline.set", v: 1, data: buildBaseline({ tools, sources: initial }) }])
    s.apply(...events)
    expect(s.projection.baseline!.tools.map((tool) => tool.name)).toEqual(["read", "shell"])
    expect(s.projection.baseline!.instructions.startsWith(BASE_SYSTEM_PROMPT)).toBe(true)
    expect(prepareInstructions(s.projection, input(initial))).toEqual([])
  })

  test("between compactions it appends changes and never writes the baseline", () => {
    const s = session()
    const baseline = s.projection.baseline
    const before = s.hashes()
    const extra = { name: "write", description: "Write a file", inputSchema: { type: "object" } }
    const events = prepareInstructions(s.projection, {
      prompt: "A different prompt.",
      tools: [...tools, extra],
      sources: replace(initial, tuesday),
      newMessageId: ids(),
    })
    expect(events.map((event) => event.type)).toEqual(["instruction.appended"])
    s.claim()
    s.apply(...events)
    expect(s.projection.baseline).toBe(baseline)
    expect(comparePrefix(before, s.hashes())).toEqual({ extension: true, appended: 1 })
    expect(s.input().at(-1)).toEqual(developer(renderUpdate(tuesday, "replaced")))
  })

  test("after a compaction it sets a new baseline from the current sources and tools", () => {
    const s = session()
    s.user("go on")
    s.step({ parts: [{ text: "Ok." }] })
    s.compact((seq) => seq)
    const extra = { name: "write", description: "Write a file", inputSchema: { type: "object" } }
    const events = prepareInstructions(s.projection, { tools: [...tools, extra], sources: replace(initial, tuesday), newMessageId: ids() })
    expect(events.map((event) => event.type)).toEqual(["baseline.set"])
    s.apply(...events)
    expect(s.request().tools.map((tool) => tool.name)).toEqual(["read", "shell", "write"])
    expect(s.request().instructions).toContain("Tuesday, 2026-11-10")
    expect(prepareInstructions(s.projection, { tools, sources: replace(initial, tuesday), newMessageId: ids() })).toEqual([])
  })
})

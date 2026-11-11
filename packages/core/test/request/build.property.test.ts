/**
 * The central property of the request builder: the prompt cache is an
 * append-only log, so the request built after any appended event must be the
 * request built before it plus appended blocks. The only exceptions are a
 * compaction, a revert and a refusal.
 *
 * Sessions are scripted and folded through the real reducer. Each one is
 * checked two ways:
 * - event by event: the request built after an event extends the one built
 *   before it, unless the event is one of the allowed breaks;
 * - as the runtime ledger sees it: each request sent (at `step.started`, and
 *   again for a retry under the same message) is checked against the previous
 *   one with `checkPrefix` and the events appended in between.
 */
import { describe, expect, test } from "bun:test"
import type { EventType, StoredEvent } from "../../src/event/durable.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import type { Projection } from "../../src/message/message.ts"
import { reduce, reduceAll } from "../../src/message/reducer.ts"
import { type PrefixBreakCause, checkPrefix } from "../../src/request/build-break.ts"
import { buildRequest } from "../../src/request/build.ts"
import { canonicalJson } from "../../src/request/canonical.ts"
import { type BlockHash, comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { BASELINE, OPTIONS, type PartSpec, READ, SHELL, Script, providerProblems } from "./session.ts"

// ---- scripted sessions ----

const INTERRUPT = "Your previous response was interrupted by the user."

const scenarios: Record<string, () => Script> = {
  "plain turns": () => {
    const s = new Script().open()
    s.user("hello")
    s.step({ parts: [{ text: "Hi." }] })
    s.release()
    s.user("what is in a.ts?")
    s.step({ parts: [{ reasoning: "look" }, { text: "It exports a." }] })
    s.release()
    return s
  },
  "tool calls, parallel calls, and a call id reused in a later step": () => {
    const s = new Script().open()
    s.user("read both files")
    s.step({ parts: [{ reasoning: "two reads" }, { call: "call_1" }, { call: "call_2", outcome: "error" }] })
    s.step({ parts: [{ call: "call_1", name: "shell", input: '{"command":"ls"}' }] })
    s.step({ parts: [{ text: "Done." }] })
    s.release()
    return s
  },
  "an interrupted step, then a new prompt": () => {
    const s = new Script().open()
    s.user("refactor it")
    s.step({
      parts: [
        { reasoning: "plan" },
        { text: "I will start with" },
        { call: "call_1" },
        { call: "call_2", outcome: "effect_unknown" },
        { call: "call_3", outcome: "not_started" },
        { reasoning: "cut off" },
      ],
      end: "interrupted",
    })
    s.interruptExecution()
    s.harness("interrupt", INTERRUPT)
    s.user("stop, do something else")
    s.step({ parts: [{ text: "Okay." }] })
    s.release()
    return s
  },
  "a step that failed before output and was retried under the same message": () => {
    const s = new Script().open()
    s.user("go")
    s.step({ retriesBeforeOutput: 2, parts: [{ call: "call_1" }] })
    s.step({ parts: [{ text: "Done." }] })
    s.release()
    return s
  },
  "a step that failed after output and continued under a new message": () => {
    const s = new Script().open()
    s.user("go")
    const failed = s.step({ parts: [{ reasoning: "first" }, { text: "Reading." }, { call: "call_1" }], end: "provider_error" })
    s.retry(failed, 2)
    s.step({ attempt: 2, parts: [{ reasoning: "again" }, { call: "call_1" }] })
    s.step({ parts: [{ text: "Done." }] })
    s.release()
    return s
  },
  "a step that failed with nothing but reasoning": () => {
    const s = new Script().open()
    s.user("go")
    const failed = s.step({ parts: [{ reasoning: "thinking" }], end: "provider_error" })
    s.retry(failed, 2)
    s.step({ attempt: 2, parts: [{ text: "Done." }] })
    s.release()
    return s
  },
  "instruction changes in the middle of a session": () => {
    const s = new Script().open()
    s.user("go")
    s.step({ parts: [{ call: "call_1" }] })
    s.instruction("date", "The date has changed.")
    s.step({ parts: [{ text: "Done." }] })
    s.release()
    s.instruction("agents:/repo/AGENTS.md", "The instructions file was edited.")
    s.user("next")
    s.step({ parts: [{ text: "Done again." }] })
    s.release()
    return s
  },
  "harness messages, appended and delivered from the inbox": () => {
    const s = new Script().open()
    s.user("run the build in the background")
    s.step({ parts: [{ call: "call_1", name: "shell" }] })
    s.background("background-command", "Command 1 finished with exit code 0.")
    s.step({ parts: [{ text: "The build passed." }] })
    s.harness("empty-response", "You returned nothing. Continue or say that you are done.")
    s.step({ parts: [{ text: "I am done." }] })
    s.release()
    return s
  },
  "a steering message between tool results and the next step": () => {
    const s = new Script().open()
    s.user("fix the bug")
    let steer = s.enqueue("placeholder")
    s.step({ parts: [{ call: "call_1" }, { call: "call_2" }], during: () => (steer = s.enqueue("also update the docs")) })
    s.deliver(steer)
    s.step({ parts: [{ text: "Both done." }] })
    s.release()
    return s
  },
  "a compaction that keeps the last messages, with a new baseline": () => {
    const s = new Script().open()
    s.user("first task")
    s.step({ parts: [{ call: "call_1" }] })
    const kept = s.instruction("date", "The date has changed.")
    s.step({ parts: [{ text: "Done." }] })
    s.compact(() => kept)
    s.baseline({ instructions: "You are a coding agent. The date is known.", tools: [READ, SHELL] })
    s.step({ parts: [{ text: "Continuing." }] })
    s.release()
    s.user("second task")
    s.step({ parts: [{ text: "Done." }] })
    s.release()
    return s
  },
  "a compaction that keeps nothing and leaves the baseline alone": () => {
    const s = new Script().open()
    s.user("first task")
    s.step({ parts: [{ call: "call_1" }] })
    s.compact((seq) => seq)
    s.step({ parts: [{ text: "Continuing." }] })
    s.release()
    return s
  },
  "a revert": () => {
    const s = new Script().open()
    s.user("first")
    s.step({ parts: [{ text: "One." }] })
    s.release()
    const second = s.user("second")
    s.step({ parts: [{ call: "call_1" }] })
    s.step({ parts: [{ text: "Two." }] })
    s.release()
    s.revert(second)
    s.user("second, differently")
    s.step({ parts: [{ text: "Two again." }] })
    s.release()
    return s
  },
  "a refusal": () => {
    const s = new Script().open()
    s.user("first")
    s.step({ parts: [{ text: "One." }] })
    s.release()
    const second = s.user("something the provider refuses")
    s.step({ parts: [{ call: "call_1" }] })
    s.step({ parts: [{ text: "I" }], end: { refusedFrom: second } })
    s.failExecution()
    s.user("something else")
    s.step({ parts: [{ text: "Sure." }] })
    s.release()
    return s
  },
}

/** A small deterministic generator (mulberry32), so a failing seed can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random session mixing every kind of step, message and break. */
function randomSession(seed: number): Script {
  const random = generator(seed)
  const below = (limit: number) => Math.floor(random() * limit)
  const chance = (probability: number) => random() < probability
  const pick = <T>(items: readonly T[]): T => items[below(items.length)]!
  const s = new Script().open()

  // Call IDs come from a pool of three, so they repeat across steps as a provider's may.
  const calls = (outcomes: readonly ("success" | "error" | "not_started" | "effect_unknown")[]): PartSpec[] =>
    ["call_1", "call_2", "call_3"]
      .filter(() => chance(0.6))
      .map((call) => ({ call, name: pick(["read", "shell"]), outcome: pick(outcomes), started: chance(0.8) ? undefined : false }))
      .map((part) => (part.started === false && part.outcome !== "error" ? { ...part, outcome: "not_started" as const } : part))
  const opening = (): PartSpec[] => [
    ...(chance(0.5) ? [{ reasoning: `thinking ${below(1000)}`, providerData: chance(0.2) ? null : undefined }] : []),
    ...(chance(0.4) ? [{ text: chance(0.1) ? "  " : `saying ${below(1000)}` }] : []),
  ]
  const toolParts = (): PartSpec[] => {
    const made = calls(["success", "success", "error"])
    return [...opening(), ...(made.length > 0 ? made : [{ call: "call_1" }])]
  }
  const between = () => {
    if (chance(0.2)) s.instruction(pick(["date", "environment", "agents:/repo/AGENTS.md"]), `changed ${below(1000)}`)
    if (chance(0.15)) s.background("background-command", `command ${below(1000)} finished`)
    if (chance(0.1)) s.harness("check", `check ${below(1000)} failed`)
    if (chance(0.12)) {
      const visible = selectModelHistory(s.projection).messages.filter((message) => message.seq >= s.floor)
      const compactionSeq = s.compact((seq) => (chance(0.3) || visible.length === 0 ? seq : pick(visible.slice(-4)).seq))
      if (chance(0.7))
        s.baseline(
          chance(0.5) ? BASELINE : { instructions: `You are a coding agent. Epoch ${compactionSeq}.`, tools: [READ, SHELL] },
        )
    }
  }

  let interrupted = false
  for (let turn = 0, turns = 2 + below(5); turn < turns; turn++) {
    if (chance(0.15)) s.instruction("date", `The date has changed (${turn}).`)
    if (interrupted) s.harness("interrupt", INTERRUPT)
    interrupted = false
    const prompt = s.user(`prompt ${turn}`, pick(["steer", "queue"]))
    let open = true
    for (let step = 0, steps = below(4); open && step < steps; step++) {
      const kind = pick(["tools", "tools", "tools", "steered", "retried", "continued", "interrupted", "refused", "blank"])
      if (kind === "tools") s.step({ parts: toolParts() })
      if (kind === "steered") {
        let steer = s.enqueue("to be cancelled")
        s.step({ parts: toolParts(), during: () => (steer = s.enqueue(`steer ${below(1000)}`)) })
        s.deliver(steer)
      }
      if (kind === "retried") s.step({ retriesBeforeOutput: 1 + below(2), parts: toolParts() })
      if (kind === "continued") {
        const failed = s.step({
          parts: [...opening(), ...calls(["success", "error", "effect_unknown"]), ...(chance(0.4) ? [{ reasoning: "cut" }] : [])],
          end: pick(["provider_error", "crashed"]),
        })
        s.retry(failed, 2)
        s.step({ attempt: 2, parts: toolParts() })
      }
      if (kind === "interrupted") {
        s.step({
          parts: [...opening(), ...calls(["success", "not_started", "effect_unknown", "error"]), ...(chance(0.4) ? [{ reasoning: "cut" }] : [])],
          end: "interrupted",
        })
        s.interruptExecution()
        interrupted = true
        open = false
      }
      if (kind === "refused") {
        s.step({ parts: chance(0.5) ? [{ text: "I" }] : [], end: { refusedFrom: Math.max(prompt, s.floor) } })
        s.failExecution()
        open = false
      }
      // A completed response with nothing in it but reasoning, which earns the empty-response nudge.
      if (kind === "blank") {
        s.step({ parts: [{ reasoning: "hm" }, ...(chance(0.5) ? [{ text: "" }] : [])] })
        s.harness("empty-response", "You returned nothing.")
      }
      if (open) between()
    }
    if (open) {
      s.step({ parts: [...opening(), { text: `answer ${turn}` }], end: pick(["stop", "stop", "length"]) })
      s.release()
    }
    if (chance(0.15)) {
      const prompts = selectModelHistory(s.projection).messages.filter(
        (message) => message.kind === "user" && message.seq >= s.floor,
      )
      if (prompts.length > 0) s.revert(pick(prompts).seq)
    }
  }
  return s
}

const SEEDS = Array.from({ length: 250 }, (_, index) => index + 1)

const sessions: readonly (readonly [string, Script])[] = [
  ...Object.entries(scenarios).map(([name, build]) => [name, build()] as const),
  ...SEEDS.map((seed) => [`random session, seed ${seed}`, randomSession(seed)] as const),
]

// ---- what is checked ----

interface Step {
  readonly event: StoredEvent
  readonly request: ModelRequest | null
  readonly before: BlockHash[] | null
  readonly after: BlockHash[] | null
}

/** Each session is walked once; several tests read the result. */
const walks = new Map<readonly StoredEvent[], Step[]>()

/** The request after each event, from the first `baseline.set` on. `before` is `null` until a baseline exists. */
function walk(events: readonly StoredEvent[]) {
  const cached = walks.get(events)
  if (cached !== undefined) return cached
  let state: Projection | null = null
  let before: BlockHash[] | null = null
  const steps = events.map((event) => {
    state = reduce(state, event)
    const request = state.baseline === null ? null : buildRequest(state, OPTIONS)
    const step = { event, request, before, after: request === null ? null : hashRequest(request) }
    before = step.after
    return step
  })
  walks.set(events, steps)
  return steps
}

// Walked while the file loads, so that no single test pays for building every request of every session.
for (const [, script] of sessions) walk(script.events)

/** The events after which a request may stop extending the one before. `baseline.set` is only ever legal after a compaction. */
const MAY_BREAK: readonly EventType[] = ["compaction.ended", "history.reverted", "step.refused", "baseline.set"]

/**
 * The requests the step loop sends, as the ledger records them: one per
 * `step.started` and one more per retry that stays under the same message.
 * Each is paired with the events appended since the previous one was built.
 */
function sent(events: readonly StoredEvent[]) {
  const steps = walk(events)
  const requests: { blocks: BlockHash[]; since: StoredEvent[] }[] = []
  let since: StoredEvent[] = []
  let running: string | null = null
  for (const step of steps) {
    since.push(step.event)
    if (step.event.type === "step.started") running = step.event.data.messageId
    if (["step.ended", "step.failed", "step.refused"].includes(step.event.type)) running = null
    const sends =
      step.event.type === "step.started" || (step.event.type === "retry.scheduled" && step.event.data.messageId === running)
    if (!sends || step.after === null) continue
    // The events up to and including this one produced the state this request was built from.
    requests.push({ blocks: step.after, since })
    since = []
  }
  return requests
}

describe("the request is an append-only log", () => {
  test("the sessions cover every kind of event the builder can meet", () => {
    const seen = new Set(sessions.flatMap(([, script]) => script.events.map((event) => event.type)))
    const expected: EventType[] = [
      "baseline.set",
      "instruction.appended",
      "inbox.enqueued",
      "inbox.delivered",
      "synthetic.appended",
      "execution.interrupted",
      "step.started",
      "step.ended",
      "step.failed",
      "step.refused",
      "retry.scheduled",
      "text.ended",
      "reasoning.ended",
      "tool.called",
      "tool.started",
      "tool.settled",
      "compaction.ended",
      "history.reverted",
    ]
    expect(expected.filter((type) => !seen.has(type))).toEqual([])
    expect(sessions.reduce((total, [, script]) => total + script.events.length, 0)).toBeGreaterThan(10_000)
  })

  test("after every appended event the request extends the one before it, except at a compaction, revert or refusal", () => {
    const violations = sessions.flatMap(([name, script]) =>
      walk(script.events).flatMap((step) => {
        if (step.before === null || step.after === null || MAY_BREAK.includes(step.event.type)) return []
        const comparison = comparePrefix(step.before, step.after)
        return comparison.extension ? [] : [`${name}: ${step.event.type} at seq ${step.event.seq} changed block ${comparison.index}`]
      }),
    )
    expect(violations).toEqual([])
  })

  test("a request built while a step or a compaction is open is the request that was built when it opened", () => {
    const changed = sessions.flatMap(([name, script]) => {
      let open = false
      return walk(script.events).flatMap((step) => {
        const within = open
        if (step.event.type === "step.started" || step.event.type === "compaction.started") open = true
        if (["step.ended", "step.failed", "step.refused", "compaction.ended", "compaction.failed"].includes(step.event.type))
          open = false
        if (!within || !open || step.before === null || step.after === null) return []
        const comparison = comparePrefix(step.before, step.after)
        return comparison.extension && comparison.appended === 0 ? [] : [`${name}: ${step.event.type} at seq ${step.event.seq}`]
      })
    })
    expect(changed).toEqual([])
  })

  test("the ledger check never reports a violation, and every break has a cause", () => {
    const verdicts = sessions.flatMap(([name, script]) => {
      let previous: BlockHash[] | null = null
      return sent(script.events).map((request) => {
        const verdict = checkPrefix(previous, request.blocks, request.since)
        previous = request.blocks
        return { name, verdict }
      })
    })
    expect(verdicts.length).toBeGreaterThan(1_000)
    expect(verdicts.filter(({ verdict }) => verdict.status === "violation").map(({ name }) => name)).toEqual([])
    const causes = new Set<PrefixBreakCause>(
      verdicts.flatMap(({ verdict }) => (verdict.status === "expected_break" ? verdict.causes : [])),
    )
    expect([...causes].sort()).toEqual(["compaction", "refusal", "revert"])
  })

  test("the only events at which the request ever breaks are compaction, revert, refusal and the baseline set after a compaction", () => {
    const breaks = new Set<EventType>()
    const strayBaselines: string[] = []
    for (const [name, script] of sessions) {
      let compactedSinceBaseline = false
      for (const step of walk(script.events)) {
        if (step.event.type === "compaction.ended") compactedSinceBaseline = true
        const broke = step.before !== null && step.after !== null && !comparePrefix(step.before, step.after).extension
        if (broke) breaks.add(step.event.type)
        if (broke && step.event.type === "baseline.set" && !compactedSinceBaseline)
          strayBaselines.push(`${name}: seq ${step.event.seq}`)
        if (step.event.type === "baseline.set") compactedSinceBaseline = false
      }
    }
    expect([...breaks].sort()).toEqual(["baseline.set", "compaction.ended", "history.reverted", "step.refused"])
    expect(strayBaselines).toEqual([])
  })

  test.each([
    ["a compaction that keeps the last messages, with a new baseline", "compaction"],
    ["a compaction that keeps nothing and leaves the baseline alone", "compaction"],
    ["a revert", "revert"],
    ["a refusal", "refusal"],
  ] as const)("%s breaks the prefix exactly once, as %s", (name, cause) => {
    let previous: BlockHash[] | null = null
    const verdicts = sent(scenarios[name]!().events).map((request) => {
      const verdict = checkPrefix(previous, request.blocks, request.since)
      previous = request.blocks
      return verdict
    })
    const broken = verdicts.filter((verdict) => verdict.status !== "extension" && verdict.status !== "first")
    expect(broken.map((verdict) => (verdict.status === "expected_break" ? verdict.causes : verdict.status))).toEqual([[cause]])
  })

  test("sessions without a compaction, revert or refusal never break", () => {
    const quiet = sessions.filter(([, script]) =>
      script.events.every((event) => !["compaction.ended", "history.reverted", "step.refused"].includes(event.type)),
    )
    expect(quiet.length).toBeGreaterThan(20)
    const broken = quiet.filter(([, script]) =>
      walk(script.events).some(
        (step) => step.before !== null && step.after !== null && !comparePrefix(step.before, step.after).extension,
      ),
    )
    expect(broken.map(([name]) => name)).toEqual([])
  })
})

describe("every request is valid and deterministic", () => {
  const requests = (script: Script) =>
    walk(script.events).flatMap((step) => (step.request === null ? [] : [{ seq: step.event.seq, request: step.request }]))

  test("every request built at any point of any session is one the provider accepts", () => {
    const problems = sessions.flatMap(([name, script]) =>
      requests(script).flatMap(({ seq, request }) =>
        providerProblems(request).map((problem) => `${name} at seq ${seq}: ${problem}`),
      ),
    )
    expect(problems).toEqual([])
  })

  test("building twice gives byte-identical canonical JSON", () => {
    for (const [, script] of sessions)
      expect(canonicalJson(buildRequest(script.projection, OPTIONS))).toBe(canonicalJson(buildRequest(script.projection, OPTIONS)))
  })

  test("a projection rebuilt from the log, or read back from JSON rows, builds the same bytes", () => {
    for (const [, script] of sessions) {
      const live = canonicalJson(script.request())
      const rebuilt = reduceAll(script.events)!
      const reread = JSON.parse(JSON.stringify(script.projection)) as Projection
      expect(canonicalJson(buildRequest(rebuilt, OPTIONS))).toBe(live)
      expect(canonicalJson(buildRequest(reread, OPTIONS))).toBe(live)
    }
  })

  test("the request never contains anything that is not JSON", () => {
    for (const [, script] of sessions) {
      const request: ModelRequest = script.request()
      expect(JSON.parse(canonicalJson(request))).toEqual(JSON.parse(JSON.stringify(request)))
    }
  })
})

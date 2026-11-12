/**
 * Agents: a role kept as a file (instructions, restrictions, sometimes a
 * model) that a session starts as, is switched to, or runs a subagent as.
 * None of it touches the frozen prefix: the tool list never changes, a
 * session that starts as an agent has the agent's instructions as a section
 * of its first baseline, and a switch is an appended message. What changes
 * is recorded (`agent.switched`), and a call the agent may not make is
 * refused before the approval layer looks at it.
 */
import { agentIndexSource, agentIndexUpdate } from "../../src/agents/agent-index.ts"
import { parseAgentDefinition } from "../../src/agents/definition.ts"
import type { AgentDefinition } from "../../src/agents/discover.ts"
import { checkAgentCall } from "../../src/agents/restrictions.ts"
import { type AgentRecord, agentRecordOf, agentSwitch } from "../../src/agents/use.ts"
import { renderChildResult, taskMessage } from "../../src/engine/spawn.ts"
import { event } from "../../src/event/durable.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import {
  MODEL,
  OTHER,
  type Scenario,
  baseline,
  c,
  called,
  created,
  deliver,
  enqueue,
  executionStarted,
  executionLeftToParent,
  executionSucceeded,
  m,
  opening,
  ran,
  say,
  settingsChanged,
  settled,
  spawnEnded,
  spawnedBy,
  stepEnded,
  stepStarted,
  toolStartedAs,
} from "./script.ts"

/** The two definitions of the scenarios' project, as the files are written. */
export const REVIEWER_FILE = "---\nname: reviewer\ndescription: Reviews a change without editing anything.\neffects: read\n---\nRead the code and report what is wrong. Do not change files.\n"
export const CAPTAIN_FILE = "---\nname: captain\ndescription: Prepares a release.\nmodel: gpt-other\neffort: high\n---\nWork on a release branch. Never push.\n"

function definition(name: string, text: string): AgentDefinition {
  const parsed = parseAgentDefinition(text, name)
  if (!parsed.ok) throw new Error(parsed.reason)
  return { ...parsed.agent, path: `/repo/.claude/agents/${name}.md`, root: { dir: "/repo/.claude/agents", scope: "project" } }
}
const REVIEWER_DEFINITION = definition("reviewer", REVIEWER_FILE)
const CAPTAIN_DEFINITION = definition("captain", CAPTAIN_FILE)
/** What a session that runs as each records: the definition as it was when it was selected. */
export const REVIEWER: AgentRecord = agentRecordOf(REVIEWER_DEFINITION)
export const CAPTAIN: AgentRecord = agentRecordOf(CAPTAIN_DEFINITION)

/** The agent the session runs as changed. Without a message: before the first baseline. */
export const switched = (messageId: string | null, from: string | null, to: AgentRecord | null) => event("agent.switched", { messageId: messageId === null ? null : m(messageId), from, to })
/** A baseline whose last section is the agent's instructions. */
export const baselineAs = (agent: AgentRecord) => {
  const plain = baseline()
  return event("baseline.set", { ...plain.data, sources: [...plain.data.sources, { source: "agent", fingerprint: fingerprintOf(agent.instructions) }] })
}
/** The instruction message that tells the model about a switch, with the text the agents module writes. */
export const announced = (id: string, from: AgentRecord | null, to: AgentRecord | null) => {
  const update = agentSwitch(from, to)
  if (update === null) throw new Error("nothing changes")
  return event("instruction.appended", { messageId: m(id), source: "agent", text: update.text, fingerprint: update.fingerprint })
}
/** The loop refuses a call the agent may not make: the record, then the result the model reads. The approval layer is off in these scenarios, which reads as mode `full`. */
const refusedByAgent = (id: string, callId: string, agent: AgentRecord, tool: string, effect: "write" | "exec") => {
  const verdict = checkAgentCall(agent, { name: tool, effect })
  if (verdict.kind !== "refuse") throw new Error(`${agent.name} allows ${tool}`)
  return [
    event("approval.denied", { messageId: m(id), callId: c(callId), mode: "full", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: agent.name, refusal: verdict.refusal }),
    settled(id, callId, "error", verdict.reason),
  ]
}
export const WRITE_FIX = '{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}'

// ---------------------------------------------------------------- a session that starts as an agent

export const startsAsAgent: Scenario = {
  title: "A session starts as a read-only agent, and a write is refused with the reason",
  description:
    "The user starts the session as the agent `reviewer`, whose definition allows only tools that read. The definition is read once, when the session is created: `agent.switched` records it right after `session.created` (its instructions, its restrictions, the fingerprint of the file), and the session never reads the file again. The first baseline carries the agent's instructions as its last section, so nothing about this differs in cache terms from a session without an agent, and the tool list is the same as every other session's: every tool stays offered. When the model calls `write`, the loop refuses the call before the approval layer looks at it: `approval.denied` names the agent whose restrictions refused it, with which of its rules it was, the call's effect class and a sentence a client shows the user, and the call's result is the sentence that tells the model so and what to do instead. The model reads it and answers.",
  provider: "step 1 calls write; step 2 answers",
  features: { agents: true },
  phases: [
    {
      label: "the session is created as the agent, and its first baseline carries the agent's instructions",
      events: [created(), switched(null, null, REVIEWER), enqueue("u1", "Fix the failing test."), executionStarted(), baselineAs(REVIEWER), deliver("u1"), stepStarted("a1"), called("a1", "call_1", "write", WRITE_FIX)],
      expect: { open: "a1", history: ["u1", "a1"] },
      rejects: [
        { event: switched(null, "reviewer", CAPTAIN), code: "invalid_transition", why: "the baseline is frozen: from here a switch is announced by an instruction message" },
        {
          event: event("approval.denied", { messageId: m("a1"), callId: c("call_1"), mode: "full", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "captain", refusal: { rule: "effect", effect: "write", text: 'The agent "captain" may use only tools that read. "write" changes files.' } }),
          code: "invalid_transition",
          why: "a call is refused by the restrictions of the agent the session runs as, and that is the reviewer",
        },
        {
          event: event("approval.denied", { messageId: m("a1"), callId: c("call_1"), mode: "full", paths: [], escalation: null, reason: "policy", needs: [], stop: false, agent: "reviewer" }),
          code: "invalid_transition",
          why: "an agent's refusal says which of its rules refused the call, the call's effect class and a sentence for the user",
        },
      ],
    },
    {
      label: "the write is refused with the sentence, and the model answers",
      events: [...refusedByAgent("a1", "call_1", REVIEWER, "write", "write"), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "As the reviewer I may not edit files. The expectation should be 2."), stepEnded("a2"), executionSucceeded()],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write error"] }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

// ---------------------------------------------------------------- a switch in the middle of a session

const firstTurn = [...opening("Why does the test fail?"), stepStarted("a1"), say("a1", "The expectation is wrong: 1 + 1 is 2."), stepEnded("a1"), executionSucceeded()]

export const switchedMidSession: Scenario = {
  title: "The user switches the agent in the middle of a session: an appended message, never a new baseline",
  description:
    "The session has run a turn without an agent. The user selects `reviewer`. The baseline is frozen, so nothing is rewritten: the switch is appended as an instruction message (source `agent`) that carries the agent's instructions, and `agent.switched` follows it in the same append, naming that message. The session is idle, so both are recorded the moment the user selects the agent, before any turn: a process that dies afterwards has not lost the choice. (They are the one kind of message that enters history without a running execution. A switch asked for while a turn runs is made at that turn's next step boundary.) The next request is the previous one plus that message and the user's: the whole cached prefix is kept. From the switch on every call is checked against the agent's restrictions. Then the user selects `captain`, which names another model and effort: the message says that its instructions replace the reviewer's, and `settings.changed` follows at the same boundary, which is the one thing here that costs the cache (once, as a model change always does). Switching the agent off is a one-line message whose fingerprint is `null`.",
  provider: "turn 1 answers. Turn 2 (as the reviewer): a write, refused, then an answer. Turn 3 (as the captain, on the other model): a write that runs, then an answer. Turn 4 (no agent): an answer",
  features: { agents: true },
  phases: [
    {
      label: "a turn without an agent",
      events: firstTurn,
      expect: { history: ["u1", "a1"], execution: null },
    },
    {
      label: "the user selects the reviewer while the session is idle: the message and the record are written at once",
      events: [announced("i1", null, REVIEWER), switched("i1", null, REVIEWER)],
      expect: { history: ["u1", "a1", "i1"], execution: null },
      rejects: [{ event: event("instruction.appended", { messageId: m("i9"), source: "skills", text: "No skills are available.", fingerprint: null }), code: "invalid_transition", why: "any other message enters history only under a running execution" }],
    },
    {
      label: "the next turn runs as the reviewer, and a write is refused",
      events: [
        enqueue("u2", "Fix it."),
        executionStarted("exe_2"),
        deliver("u2"),
        stepStarted("a2"),
        called("a2", "call_1", "write", WRITE_FIX),
        ...refusedByAgent("a2", "call_1", REVIEWER, "write", "write"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "As the reviewer I may not edit files."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: { history: ["u1", "a1", "i1", "u2", "a2", "a3"], execution: null },
      rejects: [
        { event: baseline(), code: "invalid_transition", why: "the baseline is frozen until the next compaction: a switch is appended, never folded in" },
        { event: switched("i1", "reviewer", CAPTAIN), code: "invalid_transition", why: "a switch follows at once the instruction message that announces it" },
      ],
    },
    {
      label: "the user selected the captain, which names another model: the message, the record and the settings change at one boundary",
      events: [
        announced("i2", REVIEWER, CAPTAIN),
        switched("i2", "reviewer", CAPTAIN),
        settingsChanged("gpt-other", "high"),
        enqueue("u3", "Then prepare the release."),
        executionStarted("exe_3"),
        deliver("u3"),
        stepStarted("a4", 1, "gpt-other"),
        ...ran("a4", "call_1", "write", WRITE_FIX, "Wrote a.test.ts"),
        stepEnded("a4", "tool_calls"),
        stepStarted("a5", 1, "gpt-other"),
        say("a5", "Fixed the expectation on the release branch."),
        stepEnded("a5"),
        executionSucceeded("exe_3"),
      ],
      expect: { history: ["u1", "a1", "i1", "u2", "a2", "a3", "i2", "u3", "a4", "a5"], execution: null },
    },
    {
      label: "the user switched the agent off: one line, and its restrictions no longer apply",
      events: [announced("i3", CAPTAIN, null), switched("i3", "captain", null), enqueue("u4", "Thanks."), executionStarted("exe_4"), deliver("u4"), stepStarted("a6", 1, "gpt-other"), say("a6", "You are welcome."), stepEnded("a6"), executionSucceeded("exe_4")],
      expect: { history: ["u1", "a1", "i1", "u2", "a2", "a3", "i2", "u3", "a4", "a5", "i3", "u4", "a6"], execution: null },
      rejects: [{ event: switched(null, null, REVIEWER), code: "invalid_transition", why: "the baseline is frozen: a switch is announced by an instruction message" }],
    },
  ],
}

// ---------------------------------------------------------------- a subagent run as an agent

const TASK = "Review module a"
export const DELEGATE_AS = '{"task":"Review module a","agent":"reviewer"}'
const INDEX = agentIndexUpdate(null, agentIndexSource([CAPTAIN_DEFINITION, REVIEWER_DEFINITION]))!
const childAnswer = renderChildResult(OTHER, { outcome: "completed", answer: "Module a is fine.", detail: "It finished.", steps: 1, toolCalls: 0, usage: null }, null, false)

export const subagentAsAgent: Scenario = {
  title: "A subagent is run as an agent the list of agents names",
  description:
    "The `subagent` tool has an optional `agent` argument in every session: its spec is a constant that names no agent, so the tool list never depends on which agents exist. Which ones do is told in a message: a session that is offered `subagent` gets the list of agents (name, a tag for its restrictions, one line of description) appended after its baseline, and again when the list changes. The model runs a subagent as `reviewer`. The name is checked when the call runs (a wrong one is an error result with close names, and starts nothing); `spawn.started` names the agent, and the child session is created as it. The child's result comes back like any subagent's.",
  provider: "step 1 calls subagent with `agent`; the child answers in one step; step 2 answers",
  spawn: {},
  features: { agents: true },
  phases: [
    {
      label: "the list of agents is appended after the baseline, and the model delegates to one",
      events: [
        created(),
        enqueue("u1", "Have module a reviewed."),
        executionStarted(),
        baseline(),
        event("instruction.appended", { messageId: m("i1"), source: "agent-index", text: INDEX.text, fingerprint: INDEX.fingerprint, detail: { kind: "agents", agents: [CAPTAIN, REVIEWER].map((agent) => ({ name: agent.name, path: agent.path })) } }),
        deliver("u1"),
        stepStarted("a1"),
        called("a1", "call_1", "subagent", DELEGATE_AS),
        toolStartedAs("a1", "call_1", "exec"),
        event("spawn.started", { spawnId: "bg_1", messageId: m("a1"), callId: c("call_1"), background: false, work: { kind: "subagent", sessionId: OTHER, worktree: null, agent: "reviewer" } }),
      ],
      expect: { open: "a1", history: ["i1", "u1", "a1"] },
    },
    {
      label: "the child ends; its answer is the call's result",
      events: [spawnEnded("bg_1", "completed", "It finished.", { steps: 1 }), settled("a1", "call_1", "success", childAnswer), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "The reviewer found nothing wrong in module a."), stepEnded("a2"), executionSucceeded()],
      expect: { ui: [{ id: "i1", kind: "instruction" }, { id: "u1" }, { id: "a1", calls: ["call_1 subagent success"] }, { id: "a2", status: "completed" }], execution: null },
    },
  ],
}

export const subagentAsAgentLog: Scenario = {
  title: "The log of a subagent that runs as an agent",
  description:
    "The same situation from the child's side. The child is created as the agent: `agent.switched` follows its `session.created` in the same append, and its own fresh baseline carries the agent's instructions. Its restrictions are the agent's combined with its parent's (the stricter of each), and a child started without `agent` by a parent that runs as an agent runs as the parent's agent, so a restricted session cannot get around its restrictions by handing the work to a child. Here the child tries to edit a file: the call is refused with the sentence, in its own log, and it answers. At the depth limit it is not offered `subagent`, so it is not given the list of agents.",
  provider: "the child calls write, which is refused, then answers",
  spawn: {},
  features: { agents: true },
  phases: [
    {
      label: "the child is created as the agent, is refused a write, and answers",
      events: [
        spawnedBy(TASK),
        switched(null, null, REVIEWER),
        enqueue("u1", taskMessage(TASK)),
        executionStarted(),
        baselineAs(REVIEWER),
        deliver("u1"),
        stepStarted("a1"),
        called("a1", "call_1", "write", WRITE_FIX),
        ...refusedByAgent("a1", "call_1", REVIEWER, "write", "write"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "Module a is fine."),
        stepEnded("a2"),
        executionLeftToParent(),
      ],
      expect: { ui: [{ id: "u1", kind: "user" }, { id: "a1", calls: ["call_1 write error"] }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

export const agentScenarios = [startsAsAgent, switchedMidSession, subagentAsAgent, subagentAsAgentLog]

/** The settings every scenario's session starts with, for a play that checks them. */
export const START_MODEL = MODEL

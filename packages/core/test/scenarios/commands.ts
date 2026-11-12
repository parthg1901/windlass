/**
 * Slash commands: a Markdown file whose template, with what the user typed
 * put in, is sent as the user's message. The model is sent the expanded
 * text and nothing else: no tool, no list of commands, nothing in the
 * prefix. What the log adds is where the text came from
 * (`command.expanded`, in the append of the admission), and a command that
 * names an agent switches the session to it where its message is delivered.
 *
 * And live telemetry, which adds nothing to a log at all: the scenario says
 * so by being the events of a turn without it.
 */
import type { AgentRecord } from "../../src/agents/use.ts"
import { expandTemplate } from "../../src/commands/expand.ts"
import { event } from "../../src/event/durable.ts"
import { fingerprint as fingerprintOf } from "../../src/instructions/source.ts"
import { parseFrontMatter } from "../../src/skills/frontmatter.ts"
import { CAPTAIN, REVIEWER, announced, baselineAs, switched } from "./agents.ts"
import { type Scenario, baseline, created, deliver, enqueue, executionStarted, executionSucceeded, m, opening, ran, say, settingsChanged, stepEnded, stepStarted, turnEnded } from "./script.ts"

/** The command files of the scenarios' project, as they are written. */
export const RELEASE_NOTES_FILE = [
  "---",
  "description: Draft release notes for a version",
  "argument-hint: <version> [previous-version]",
  "---",
  "Draft the release notes for version $1 from the commits since $2.",
  "",
  "Start from !`git log --oneline` and what @docs/CHANGES.md already lists. Do not edit any file: show me the notes.",
  "",
].join("\n")
export const REVIEW_FILE = "---\ndescription: Review the uncommitted changes as a strict reviewer\nagent: reviewer\n---\nReview the uncommitted changes (git diff, and git diff --staged). $ARGUMENTS\n"
export const SHIP_FILE = "---\ndescription: Prepare a release\nagent: captain\n---\nPrepare release $1 on a release branch.\n"

/** What a command file sends for what was typed after its name, and the record the log keeps of it. */
function use(name: string, file: string, typed: string, agent?: AgentRecord) {
  const parsed = parseFrontMatter(file)
  if (!parsed.ok) throw new Error(parsed.reason)
  const expansion = expandTemplate(parsed.body, typed)
  return {
    text: expansion.text,
    expanded: (id: string) =>
      event("command.expanded", {
        messageId: m(id),
        name,
        path: `/repo/.claude/commands/${name}.md`,
        scope: "project",
        fingerprint: fingerprintOf(file),
        arguments: expansion.raw,
        missing: [...expansion.missing],
        unused: [...expansion.unused],
        unsupported: expansion.unsupported.map((construct) => ({ kind: construct.kind, text: construct.text, line: construct.line })),
        // The agent the command names, as its definition was when the command was sent: it waits with the message.
        ...(agent === undefined ? {} : { agent }),
      }),
  }
}

/** `/release-notes 1.4`: the second argument is not given, and the template holds two constructs that are left as text. */
export const RELEASE_NOTES_ARGS = "1.4"
const NOTES = use("release-notes", RELEASE_NOTES_FILE, RELEASE_NOTES_ARGS)
/** `/review focus on the tests`, run under the reviewer. */
export const REVIEW_ARGS = "focus on the tests"
const REVIEW = use("review", REVIEW_FILE, REVIEW_ARGS, REVIEWER)
/** `/ship 1.4`, run under the captain, which names another model. */
export const SHIP_ARGS = "1.4"
const SHIP = use("ship", SHIP_FILE, SHIP_ARGS, CAPTAIN)

export const commandSent: Scenario = {
  title: "The user sends a slash command: the expanded text is the message, and the log says which command produced it",
  description:
    "The project has a command file, `.claude/commands/release-notes.md`: a prompt template with `$1` and `$2`. The user types `/release-notes 1.4`. The file is read once, then: its template is expanded with what was typed, and the result is admitted as the user's message, like any prompt. In the same append `command.expanded` records where that text came from: the command's name and file, the fingerprint of the file as it was read (so the version that was used is known after the file changes), the arguments as typed, and that position 2 was used by the template and not given (it became empty text). The template also holds a command in backticks after `!` and an `@path`, which other harnesses run and read at this moment. Here nothing in a command file runs anything or reads anything: both stay in the text exactly as written, and the record lists them, for the user. The model is sent the expanded text and nothing else: there is no tool for commands, no list of them, and the request is the one a typed prompt of the same words would have made. The model can run `git log` and read the file itself, with its tools, which are decided like any call.",
  provider: "the model answers the expanded prompt",
  features: { commands: true },
  phases: [
    {
      label: "the command is expanded and admitted: the message and the record of where it came from, in one append",
      events: [created(), enqueue("u1", NOTES.text), NOTES.expanded("u1")],
      expect: { inbox: ["u1"], execution: null },
      rejects: [
        { event: NOTES.expanded("u1"), code: "invalid_transition", why: "the record belongs to the admission it follows at once: it is written with it, never later" },
        { event: NOTES.expanded("u9"), code: "not_found", why: "a command's record names a message that waits in the inbox" },
      ],
    },
    {
      label: "the turn runs on the expanded text",
      events: [executionStarted(), baseline(), deliver("u1"), stepStarted("a1"), say("a1", "Here are the notes for 1.4. Which version came before it?"), stepEnded("a1"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1", kind: "user", text: NOTES.text, command: "/release-notes 1.4" }, { id: "a1", status: "completed" }],
        history: ["u1", "a1"],
        execution: null,
      },
      rejects: [{ event: NOTES.expanded("u1"), code: "not_found", why: "a delivered message is history: nothing is recorded about it afterwards" }],
    },
  ],
}

export const commandWithAgent: Scenario = {
  title: "A command that names an agent: the session switches to it where the command's message is delivered",
  description:
    "A command file may name an agent (`agent: reviewer`). The first thing the user types in a new session is `/review focus on the tests`. The command's text is admitted with its record, and the agent's definition is read then, once. Where the message is delivered, right before it, the session switches to the agent: no baseline is set yet, so `agent.switched` is the record alone and the first baseline carries the reviewer's instructions as its last section, exactly as for a session that was started as the reviewer. Later, while the model is answering a question, the user queues `/ship 1.4`, a command that runs under `captain`. A queued message waits for the turn in progress, and so does its switch: the reviewer answers the question as the reviewer. The switch waits in the log: `command.expanded` carries the agent's record as it was read when the command was sent, so a process that dies before the delivery and starts again makes the same switch. At the boundary where the queued message is delivered the switch is made first, as an appended instruction message and `agent.switched` (the baseline is frozen), then `settings.changed` because the captain names another model, then the turn's ending and the delivery. A command whose agent cannot be found sends nothing at all.",
  provider: "turn 1 (as the reviewer) answers. Turn 2 answers the question; the queued command's turn (as the captain, on the other model) answers",
  features: { commands: true, agents: true },
  phases: [
    {
      label: "the first message is a command that runs under the reviewer: the switch is recorded before the first baseline, which carries the agent",
      events: [created(), enqueue("u1", REVIEW.text), REVIEW.expanded("u1"), executionStarted(), switched(null, null, REVIEWER), baselineAs(REVIEWER), deliver("u1"), stepStarted("a1"), say("a1", "The tests do not cover the empty list."), stepEnded("a1"), executionSucceeded()],
      expect: { ui: [{ id: "u1", command: "/review focus on the tests" }, { id: "a1", status: "completed" }], history: ["u1", "a1"], execution: null },
    },
    {
      label: "a question, and while it is answered the user queues a command that runs under the captain",
      events: [enqueue("u2", "Which test is closest?"), executionStarted("exe_2"), deliver("u2"), stepStarted("a2"), enqueue("u3", SHIP.text, "queue"), SHIP.expanded("u3"), say("a2", "sum.test.ts."), stepEnded("a2")],
      expect: { inbox: ["u3"], history: ["u1", "a1", "u2", "a2"] },
    },
    {
      label: "where the queued command is delivered: the switch, the model change it brings, the turn's ending and the delivery",
      events: [
        announced("i1", REVIEWER, CAPTAIN),
        switched("i1", "reviewer", CAPTAIN),
        settingsChanged("gpt-other", "high"),
        turnEnded(),
        deliver("u3"),
        stepStarted("a3", 1, "gpt-other"),
        say("a3", "Release 1.4 is prepared on release/1.4."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "u2", command: null }, { id: "a2" }, { id: "i1", kind: "instruction" }, { id: "u3", command: "/ship 1.4" }, { id: "a3", status: "completed" }],
        history: ["u1", "a1", "u2", "a2", "i1", "u3", "a3"],
        execution: null,
      },
    },
  ],
}

export const telemetryOn: Scenario = {
  title: "Live telemetry is on: the turn's log is the log it would be without, and its spans are sent as it runs",
  description:
    "The user's own configuration turns `telemetry` on and names a collector. Nothing about the turn changes: no event is written for telemetry, no request carries anything of it, and the log is event for event the log of the same turn without it (this scenario's events are those of \"One tool call, then an answer\"). Beside the loop, the session's log and its request ledger are mapped to spans at the events where a span closes, with the mapping an export after the fact uses, so both give the same spans with the same IDs: the tool call when it has settled, each model call when its step has ended, the turn when the execution has. Each span is queued once and sent in the background. A collector that is slow, down or wrong costs the queue's memory and nothing else, and a project's configuration can turn the export off but never on. Message text, tool arguments and tool output are not in the spans unless the user's file asks for content.",
  provider: "step 1 streams text and one tool call; step 2 answers",
  features: { telemetry: true },
  phases: [
    {
      label: "the turn, as without telemetry",
      events: [
        ...opening(),
        stepStarted("a1"),
        say("a1", "Let me read the test."),
        ...ran("a1", "call_1", "read", '{"path":"a.test.ts"}', "expect(add(1, 1)).toBe(3)"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "The expectation is wrong: 1 + 1 is 2."),
        stepEnded("a2", "stop"),
        executionSucceeded(),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: ["call_1 read success"] }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"], execution: null, open: null },
    },
  ],
}

export const commandScenarios: readonly Scenario[] = [commandSent, commandWithAgent, telemetryOn]

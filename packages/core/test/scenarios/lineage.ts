/**
 * Sessions that come from other sessions: a fork (its parent's history is
 * its history), a replay (a recording, answered from the recording), and a
 * subagent (a fresh conversation started by a tool call), together with the
 * background work a session spawns beside its steps.
 *
 * A scenario is one session's log. A fork's log holds its parent's events
 * first; a replay's and a subagent's start at seq 1 and name the session
 * they come from (`ses_other`).
 */
import { event } from "../../src/event/durable.ts"
import { REPLAY_TEXT } from "../../src/engine/replay.ts"
import { SPAWN_TEXT, renderChildResult, renderCommandEnd, taskMessage } from "../../src/engine/spawn.ts"
import { STOPPED_OUTPUT } from "../../src/replay/replay.ts"
import {
  OTHER,
  type Scenario,
  baseline,
  called,
  deliver,
  enqueue,
  executionStarted,
  executionSucceeded,
  forked,
  opening,
  replayCall,
  replayCreated,
  replayDiverged,
  replayEnded,
  say,
  settled,
  spawnEnded,
  spawnStarted,
  spawnedBy,
  stepEnded,
  stepStarted,
  toolStarted,
  toolStartedAs,
  x,
} from "./script.ts"

// ---------------------------------------------------------------- fork

export const forkContinues: Scenario = {
  title: "A fork continues from its parent's history",
  description:
    "A session is forked at a step boundary. The fork is a session of its own (its own file, its own events from here on) whose history is the parent's up to the fork point: the first event of its own names the parent and the last inherited seq. It starts idle with an empty inbox, with the parent's baseline, settings and taint and the root session's cache key, so its first request is the parent's last request plus the new prompt. The parent is only read and may be working elsewhere meanwhile.",
  provider: "the parent answers one prompt; the fork answers another",
  phases: [
    {
      label: "the parent's step is open",
      events: [...opening("What does add do?"), stepStarted("a1")],
      expect: { open: "a1" },
      rejects: [{ event: forked(6), code: "invalid_transition", why: "a fork point is a step boundary: the history up to it must be whole" }],
    },
    {
      label: "the parent's turn ends",
      events: [say("a1", "It adds two numbers."), stepEnded("a1"), executionSucceeded()],
      expect: { execution: null, history: ["u1", "a1"] },
      rejects: [{ event: forked(4), code: "invalid_range", why: "a fork is folded onto its parent at exactly the seq it names" }],
    },
    {
      label: "the fork is created and takes a prompt of its own",
      events: [forked(9), enqueue("u2", "And subtract?"), executionStarted("exe_2"), deliver("u2"), stepStarted("a2"), say("a2", "There is no subtract."), stepEnded("a2"), executionSucceeded("exe_2")],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "u2", kind: "user" }, { id: "a2", status: "completed" }],
        history: ["u1", "a1", "u2", "a2"],
        execution: null,
        inbox: [],
      },
    },
  ],
}

// ---------------------------------------------------------------- replay

const READ_A = '{"path":"a.test.ts"}'
const EXPECTATION = "expect(add(1, 1)).toBe(3)"
const LEFT = "left the recording at step 1, call 1: arguments differ"

/** How every replay scenario begins: the replay session, its claim, the changed baseline, the recording's prompt delivered as it was. */
const replayOpening = (policy: "stop" | "execute") => [replayCreated(policy, 14), executionStarted(), baseline(), enqueue("u1", "Fix the failing test."), deliver("u1")]

export const replayIdentical: Scenario = {
  title: "A replay that stays on its recording",
  description:
    "A recorded session (a read, then an answer) is replayed against a changed system prompt. The replay is a session of its own, typed as a replay of the recording. Its baseline is the recording's with the new prompt; the recording's prompt is delivered where it arrived. The model makes the recorded call: it is answered from the recording (`replay.call matched`, then the recorded `tool.started` and the recorded result, byte for byte) and nothing runs. No snapshot is taken, no check runs, nobody is asked. When the recording's last step is replayed the execution ends, and `replay.ended` says the replay was identical.",
  provider: "as in the recording: step 1 calls read with the recorded arguments; step 2 answers",
  phases: [
    {
      label: "the replay session starts with the changed baseline and the recorded prompt",
      events: replayOpening("stop"),
      expect: { history: ["u1"], execution: { status: "running", crashResumes: 0 } },
      rejects: [{ event: replayDiverged("arguments_differ"), code: "invalid_transition", why: "under the stop policy a replay ends where it leaves the recording; it has no copy to carry on in" }],
    },
    {
      label: "the model makes the recorded call and is given the recorded result",
      events: [stepStarted("a1"), called("a1", "call_1", "read", READ_A)],
      expect: { open: "a1" },
      rejects: [
        { event: replayCall("a1", "call_1", "matched"), code: "invalid_transition", why: "a matched call names the recorded call it matched" },
        { event: replayCall("a1", "call_1", "diverged", { recorded: [0, 0], divergence: "arguments_differ" }), code: "invalid_transition", why: "only a matched call names a recorded call" },
      ],
    },
    {
      label: "the recording's answer follows, and the replay ends as identical",
      events: [
        toolStarted("a1", "call_1", "read"),
        replayCall("a1", "call_1", "matched", { recorded: [0, 0] }),
        settled("a1", "call_1", "success", EXPECTATION),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "The expectation is wrong."),
        stepEnded("a2"),
        executionSucceeded(),
        replayEnded("identical", "all 2 recorded steps replayed without a divergence"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read success"] }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"], execution: null },
      rejects: [{ event: replayEnded("identical", "again"), code: "invalid_transition", why: "a replay ends once" }],
    },
  ],
}

export const replayStops: Scenario = {
  title: "A replay that leaves its recording stops there",
  description:
    "Under the `stop` policy. The replayed model reads another file than the recording did. That call is not on the recording: it is recorded as the divergence (`replay.call diverged`, with the kind), it is not run, and it settles as not started with a text that says the replay stopped. The step closes, and the execution ends without an answer, marked as ended by the replay (`execution.failed` with `cause: replay`: nothing failed, but there is no answer to end on). `replay.ended` carries the report: where the replay left and what the recording did there.",
  provider: "step 1 calls read with other arguments than the recording's",
  phases: [
    {
      label: "the model calls read with other arguments",
      events: [...replayOpening("stop"), stepStarted("a1"), called("a1", "call_1", "read", '{"path":"b.test.ts"}')],
      expect: { open: "a1" },
    },
    {
      label: "the call is not run, and the replay ends there",
      events: [
        replayCall("a1", "call_1", "diverged", { divergence: "arguments_differ" }),
        settled("a1", "call_1", "not_started", STOPPED_OUTPUT),
        stepEnded("a1", "tool_calls"),
        event("execution.failed", { executionId: x("exe_1"), message: REPLAY_TEXT.ended(LEFT), cause: "replay" }),
        replayEnded("diverged", LEFT),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read not_started"] }], execution: null, open: null },
    },
  ],
}

export const replayExecutes: Scenario = {
  title: "A replay that leaves its recording carries on in a copy",
  description:
    "Under the `execute` policy. At the first call that is not on the recording, the recorded workspace as it was at that point is restored into a copy (`replay.diverged`: the directory and the snapshot it was restored from; here the recording has none, so the copy starts empty), and from there the replay is an ordinary turn in that copy: the call runs for real (`replay.call diverged executed`), with the sandbox and without the network where the approval layer is on, and the turn runs to its answer. The recording's workspace is never touched. `replay.ended` says the replay diverged; what the copy holds can be graded.",
  provider: "step 1 calls read with other arguments than the recording's; step 2 answers",
  phases: [
    {
      label: "the model leaves the recording; the copy is made and the call runs in it",
      events: [
        ...replayOpening("execute"),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"b.test.ts"}'),
        replayDiverged("arguments_differ"),
        toolStarted("a1", "call_1", "read"),
        replayCall("a1", "call_1", "diverged", { divergence: "arguments_differ", executed: true }),
        settled("a1", "call_1", "success", "expect(sub(2, 1)).toBe(1)"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { open: null, execution: { status: "running", crashResumes: 0 } },
      rejects: [{ event: replayDiverged("extra_call"), code: "invalid_transition", why: "a replay leaves its recording once" }],
    },
    {
      label: "the turn runs to its answer in the copy",
      events: [stepStarted("a2"), say("a2", "b.test.ts is fine."), stepEnded("a2"), executionSucceeded(), replayEnded("diverged", LEFT)],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read success"] }, { id: "a2", status: "completed" }], execution: null },
    },
  ],
}

// ---------------------------------------------------------------- subagents and background work

const TASK = "Fix module a"
const DELEGATE = '{"task":"Fix module a"}'
const childAnswer = (steps: number, toolCalls: number) =>
  renderChildResult(OTHER, { outcome: "completed", answer: "a.ts is fixed.", detail: "It finished.", steps, toolCalls, usage: null }, null, false)

export const subagentReturns: Scenario = {
  title: "A subagent runs a task and its answer is the call's result",
  description:
    "The model hands a task to a subagent. The call starts like any tool (its effect class says the step may change files); the child session is named in the parent's log (`spawn.started`) before it exists. The child runs its own loop in the same workspace with a fresh conversation. When it ends, `spawn.ended` records how, and what its model calls cost (rolled up into the parent's totals), and the call settles with the child's final answer and a reference to its session. Several such calls in one response run side by side. The subagent's turn is not verified; the parent's is.",
  provider: "step 1 calls subagent; the child answers in one step; step 2 answers",
  spawn: {},
  phases: [
    {
      label: "the model asks for a subagent",
      events: [...opening("Fix module a with a subagent."), stepStarted("a1"), called("a1", "call_1", "subagent", DELEGATE)],
      expect: { open: "a1" },
      rejects: [{ event: spawnStarted("bg_1", "a1", "call_1", "subagent"), code: "invalid_transition", why: "work is spawned by a tool call that is running: its start is durable first" }],
    },
    {
      label: "the child is started and runs",
      events: [toolStartedAs("a1", "call_1", "exec"), spawnStarted("bg_1", "a1", "call_1", "subagent")],
      expect: { open: "a1" },
      rejects: [
        { event: spawnStarted("bg_1", "a1", "call_1", "subagent"), code: "duplicate_id", why: "a piece of spawned work starts once" },
        { event: spawnEnded("bg_2", "completed", "It finished.", { steps: 1 }), code: "not_found", why: "only work that is running ends" },
      ],
    },
    {
      label: "the child ends; its answer is the call's result",
      events: [spawnEnded("bg_1", "completed", "It finished.", { steps: 1 }), settled("a1", "call_1", "success", childAnswer(1, 0)), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "Module a is fixed."), stepEnded("a2"), executionSucceeded()],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 subagent success"] }, { id: "a2", status: "completed" }], execution: null },
      rejects: [{ event: spawnEnded("bg_1", "completed", "It finished.", { steps: 1 }), code: "not_found", why: "spawned work ends once" }],
    },
  ],
}

export const subagentLog: Scenario = {
  title: "The subagent's own log",
  description:
    "The same situation from the child's side. A subagent is a real session, typed as spawned by its parent: it starts at seq 1 with a fresh conversation (the baseline and its task; nothing of the parent's history), the parent's settings and working directory, and a cache key of its own. Its task is delivered like a prompt, with a note that says who reads its answer. It ends like any turn, without the verification gate. At the depth limit (one level by default) its tool list has no `subagent`.",
  provider: "the child answers in one step",
  spawn: {},
  phases: [
    {
      label: "the child is created with its task and works",
      events: [spawnedBy(TASK), enqueue("u1", taskMessage(TASK)), executionStarted(), baseline(), deliver("u1"), stepStarted("a1"), say("a1", "a.ts is fixed."), stepEnded("a1"), executionSucceeded()],
      expect: { ui: [{ id: "u1", kind: "user" }, { id: "a1", status: "completed" }], history: ["u1", "a1"], execution: null },
      rejects: [{ event: spawnEnded("bg_1", "completed", "It finished."), code: "not_found", why: "the end of the child's work is recorded in its parent's log, not its own" }],
    },
  ],
}

export const subagentInBackground: Scenario = {
  title: "A background subagent's answer arrives as a message",
  description:
    "With `background: true` the call returns at once with the child's reference, and the model goes on. When the model has nothing more to do while the child still works, the turn does not end: the loop waits at the boundary (the checks would see the child's work half done). When the child ends, `spawn.ended` and the message that carries its answer are one append; the message is a harness message (`subagent_result`), delivered as a steer at the boundary, and the model answers it. Had the session been idle (its own turn failed, say), the message would have started a new execution.",
  provider: "step 1 calls subagent with background; step 2 says it started; the child, which read a file meanwhile, answers; step 3 reports",
  spawn: {},
  phases: [
    {
      label: "the call returns at once and the model goes on",
      events: [
        ...opening("Fix module a in the background."),
        stepStarted("a1"),
        called("a1", "call_1", "subagent", '{"task":"Fix module a","background":true}'),
        toolStartedAs("a1", "call_1", "exec"),
        spawnStarted("bg_1", "a1", "call_1", "subagent", true),
        settled("a1", "call_1", "success", SPAWN_TEXT.startedSubagent(OTHER)),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "Started."),
        stepEnded("a2"),
      ],
      expect: { execution: { status: "running", crashResumes: 0 }, open: null, inbox: [] },
    },
    {
      label: "the child ends: its answer is delivered, and the model reports",
      events: [
        spawnEnded("bg_1", "completed", "It finished.", { steps: 2 }),
        enqueue("s1", childAnswer(2, 1), "steer", "subagent_result"),
        deliver("s1"),
        stepStarted("a3"),
        say("a3", "The subagent fixed module a."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "s1", kind: "synthetic", origin: "subagent_result" }, { id: "a3", status: "completed" }], execution: null, inbox: [] },
    },
  ],
}

const TESTS = "bun test"
const LOG = "/tmp/.spill/bg.log"
const exited = renderCommandEnd("bg_1", { command: TESTS, exitCode: 0, signal: null, timedOut: false, stopped: null, durationMs: 2500, output: "3 pass\n", logPath: LOG })

export const backgroundCommandWakes: Scenario = {
  title: "A background command's exit wakes the idle session",
  description:
    "The shell tool's `background` argument starts a command and returns a handle at once. The command is spawned work of the session (`spawn.started`): it runs beside the steps, in the same sandbox a foreground command would, and is stopped when the session is interrupted or closed. The turn ends while it runs. When it exits, `spawn.ended` (with the exit code) and a harness message with the end of its output (`background_command`) are one append; the session is idle, so the message starts a new execution, is delivered, and the model answers.",
  provider: "step 1 calls shell with background; step 2 answers; after the command exits, step 3 answers",
  spawn: {},
  phases: [
    {
      label: "the command is started in the background and the turn ends",
      events: [
        ...opening("Run the tests in the background."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test","background":true}'),
        toolStarted("a1", "call_1", "shell"),
        spawnStarted("bg_1", "a1", "call_1", { command: TESTS, logPath: LOG }, true),
        settled("a1", "call_1", "success", "Started in the background as bg_1."),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "The tests are running."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: { execution: null, inbox: [] },
    },
    {
      label: "the command exits; the message wakes the session",
      events: [
        spawnEnded("bg_1", "completed", exited.split("\n")[0]!, { exitCode: 0 }),
        enqueue("s1", exited, "steer", "background_command"),
        executionStarted("exe_2"),
        deliver("s1"),
        stepStarted("a3"),
        say("a3", "The tests pass."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "s1", kind: "synthetic", origin: "background_command" }, { id: "a3" }], execution: null, inbox: [] },
    },
  ],
}

export const backgroundCommandLost: Scenario = {
  title: "A background command is lost when the process dies",
  description:
    "A background command dies with the harness process: the guard that every command has kills its process group. The session's log still says it runs. When the session is opened again, the command is recorded as lost (`spawn.ended lost`) together with a harness message that says so (`spawn_lost`). Opening a session starts nothing, so the message waits in the inbox and is delivered, before the user's next prompt, when that prompt starts the next turn.",
  provider: "step 1 calls shell with background; step 2 answers; the process dies; the user asks again; step 3 answers",
  spawn: {},
  phases: [
    {
      label: "the command runs in the background; the turn ends; the process dies",
      events: [
        ...opening("Watch the tests."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test --watch","background":true}'),
        toolStarted("a1", "call_1", "shell"),
        spawnStarted("bg_1", "a1", "call_1", { command: "bun test --watch", logPath: LOG }, true),
        settled("a1", "call_1", "success", "Started in the background as bg_1."),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "Watching."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: { execution: null },
    },
    {
      label: "at the next start the command is recorded as lost; the model is told with the next prompt",
      events: [
        spawnEnded("bg_1", "lost", SPAWN_TEXT.commandLostDetail),
        enqueue("s1", SPAWN_TEXT.commandLost("bg_1", "bun test --watch", LOG), "steer", "spawn_lost"),
        enqueue("u2", "Still watching?"),
        executionStarted("exe_2"),
        deliver("s1"),
        deliver("u2"),
        stepStarted("a3"),
        say("a3", "The watcher stopped when the harness restarted."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "s1", kind: "synthetic", origin: "spawn_lost" }, { id: "u2", kind: "user" }, { id: "a3" }], execution: null, inbox: [] },
    },
  ],
}

export const lineageScenarios = [forkContinues, replayIdentical, replayStops, replayExecutes, subagentReturns, subagentLog, subagentInBackground, backgroundCommandWakes, backgroundCommandLost]


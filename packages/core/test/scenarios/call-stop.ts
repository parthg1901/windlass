/**
 * The user stops one running tool call and the turn goes on.
 *
 * Unlike a cancel (`cancel.ts`), nothing is interrupted: the request is
 * recorded for that call (`tool.cancel_requested`) before its own abort
 * signal fires, the call settles as any running call does, the step carries
 * on with its other calls, and the model reads the result like any other.
 * What the result is depends on what the tool could do about it: a command
 * reports what it had printed and that the user stopped it; a subagent is
 * interrupted and its call says so; a read, or a write that cannot be
 * stopped midway, finishes as ever; a tool that reports nothing is settled
 * from the effect class it started with.
 */
import { renderChildResult } from "../../src/engine/spawn.ts"
import {
  CANCELLED_EFFECT_UNKNOWN,
  OTHER,
  STOPPED_BY_USER,
  type Scenario,
  called,
  cancelRequested,
  executionInterrupted,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  opening,
  say,
  settled,
  spawnEnded,
  spawnStarted,
  stepEnded,
  stepInterrupted,
  stepStarted,
  toolStarted,
  toolStartedAs,
} from "./script.ts"

/** What the shell returns for a command the user stopped: what it had printed, and the line that says so. */
export const STOPPED_TESTS = `12 pass\n${STOPPED_BY_USER}`

export const oneCommandStopped: Scenario = {
  title: "The user stops one command and the turn goes on",
  description:
    "A test run hangs. The user stops that call, not the turn. The request is recorded for the call (`tool.cancel_requested`) before anything is stopped, then the call's own abort signal fires with a reason that says the user stopped this call. The shell kills the process group and returns what the command had printed, with a line that says the user stopped it, so the call settles as `error` with that output: an outcome was observed. The execution is not interrupted: the step ends like any step whose calls have their results, and the model reads the result in its next request and carries on. Only a call that is running can be stopped this way, and only once.",
  provider: "step 1 calls shell with a test run that never returns; the user stops that call; step 2 answers",
  phases: [
    {
      label: "the model asks for the command",
      events: [...opening("Run the tests."), stepStarted("a1"), called("a1", "call_1", "shell", '{"command":"bun test"}')],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell pending"] }] },
      rejects: [{ event: cancelRequested("a1", "call_1"), code: "invalid_transition", why: "only a call that is running is stopped by itself; one that has not started is declined, or never begins" }],
    },
    {
      label: "the command hangs; the user stops that call",
      events: [toolStarted("a1", "call_1", "shell"), cancelRequested("a1", "call_1")],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0 }, ui: [{ id: "u1" }, { id: "a1", status: "running", calls: ["call_1 shell running (stopped by the user)"] }] },
      rejects: [
        { event: cancelRequested("a1", "call_1"), code: "invalid_transition", why: "a call is asked to stop once" },
        { event: cancelRequested("a1", "call_2"), code: "not_found", why: "the request names a call of the step" },
        { event: stepEnded("a1", "tool_calls"), code: "invalid_transition", why: "the step waits for the stopped call's result like for any other" },
        { event: settled("a1", "call_1", "not_started", "Not run."), code: "invalid_transition", why: "a call that started is never recorded as not started, also when it was stopped" },
      ],
    },
    {
      label: "the shell returns what the command had printed; the step ends and the model answers",
      events: [settled("a1", "call_1", "error", STOPPED_TESTS), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "The test run hung after 12 tests, so you stopped it. The next test is the one to look at."), stepEnded("a2"), executionSucceeded()],
      expect: {
        execution: null,
        open: null,
        ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: ["call_1 shell error (stopped by the user)"] }, { id: "a2", status: "completed" }],
        history: ["u1", "a1", "a2"],
      },
      rejects: [{ event: cancelRequested("a1", "call_1"), code: "invalid_transition", why: "nothing is stopped once the turn is over" }],
    },
  ],
}

export const stoppedCallReportsNothing: Scenario = {
  title: "A stopped call that reports nothing is settled from its effect class, and the step's other call finishes",
  description:
    "Two calls of one step run side by side: a command and a file read. The user stops the command. Its tool reports nothing: it throws while it is being stopped, or does not come back within the grace period a stopping tool is given (then whatever it returns later is dropped). The loop settles the call from the effect class it started with, exactly as it does for a call an interrupt reached: a command may have had its effect, so the outcome is `effect_unknown`, and the text says that the user stopped this call and that the state must be checked. A read in the same place would settle as `error`: it changed nothing. The other call is not touched: the read finishes with its result, the step ends, and the model goes on.",
  provider: "step 1 calls shell and read; the user stops the shell call, whose tool reports nothing; the read finishes; step 2 answers",
  phases: [
    {
      label: "both calls run",
      events: [
        ...opening("Apply the migration and show me a.ts."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun run migrate"}'),
        toolStarted("a1", "call_1", "shell"),
        called("a1", "call_2", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_2", "read"),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell running", "call_2 read running"] }] },
    },
    {
      label: "the user stops the command; its tool reports nothing",
      events: [cancelRequested("a1", "call_1"), settled("a1", "call_1", "effect_unknown", CANCELLED_EFFECT_UNKNOWN)],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell effect_unknown (stopped by the user)", "call_2 read running"] }] },
      rejects: [
        { event: cancelRequested("a1", "call_1"), code: "invalid_transition", why: "a call that has its result is over" },
        { event: settled("a1", "call_2", "effect_unknown", CANCELLED_EFFECT_UNKNOWN), code: "invalid_transition", why: "a read changes nothing, whoever stops it" },
      ],
    },
    {
      label: "the read finishes; the step ends and the model goes on",
      events: [settled("a1", "call_2", "success", "export const a = 1"), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "a.ts exports a = 1. I do not know whether the migration was applied: let me check its status."), stepEnded("a2"), executionSucceeded()],
      expect: { execution: null, ui: [{ id: "u1" }, { id: "a1", status: "completed" }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"] },
    },
  ],
}

export const readFinishesAnyway: Scenario = {
  title: "A call that cannot be stopped midway finishes with its ordinary result",
  description:
    "The user asks for a file read to stop. A read (like a write, which is one rename) cannot be stopped midway and takes no time worth stopping: the tool finishes and the call settles with its ordinary result, as if nobody had asked. The request stays on record with the call, so a client can show that it was made; the model reads the file's content.",
  provider: "step 1 calls read; the user asks for it to stop while it runs; the read returns the file; step 2 answers",
  phases: [
    {
      label: "the read runs and the user asks for it to stop",
      events: [...opening("What does a.ts export?"), stepStarted("a1"), called("a1", "call_1", "read", '{"path":"a.ts"}'), toolStarted("a1", "call_1", "read"), cancelRequested("a1", "call_1")],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read running (stopped by the user)"] }] },
    },
    {
      label: "the read finishes as ever",
      events: [settled("a1", "call_1", "success", "export const a = 1"), stepEnded("a1", "tool_calls"), stepStarted("a2"), say("a2", "It exports a = 1."), stepEnded("a2"), executionSucceeded()],
      expect: { execution: null, ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read success (stopped by the user)"] }, { id: "a2" }], history: ["u1", "a1", "a2"] },
    },
  ],
}

/** What the second command returns when the interrupt of the whole turn reaches it. */
export const INTERRUPTED_LINT = "[Interrupted by the user. The command and its child processes were stopped; the output above is everything it printed before that.]"

export const stoppedThenInterrupted: Scenario = {
  title: "The user stops one call and then the whole turn",
  description:
    "Two commands run side by side. The user stops the first, and before it has reported, stops the turn. The interrupt is recorded like any (`execution.interrupt_requested`) and from then on the execution only winds down: no single call is stopped any more, because everything stops. Each call settles once with what its tool observed (the first was stopped as a call, the second by the interrupt, and each result says which), the step closes as interrupted, the marker follows, and the claim is released.",
  provider: "step 1 calls shell twice; the user stops the first call, then cancels the turn; both commands return what they had printed",
  phases: [
    {
      label: "two commands run; the user stops the first",
      events: [
        ...opening("Run the tests and the linter."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1", "shell"),
        called("a1", "call_2", "shell", '{"command":"bun run lint"}'),
        toolStarted("a1", "call_2", "shell"),
        cancelRequested("a1", "call_1"),
      ],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0 } },
    },
    {
      label: "the user cancels the turn",
      events: [interruptRequested("user")],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0, interrupting: "user" } },
      rejects: [{ event: cancelRequested("a1", "call_2"), code: "invalid_transition", why: "once an interrupt was requested everything stops: no single call is stopped any more" }],
    },
    {
      label: "both commands return what they had printed; the turn ends as interrupted",
      events: [
        settled("a1", "call_1", "error", STOPPED_TESTS),
        settled("a1", "call_2", "error", INTERRUPTED_LINT),
        stepInterrupted("a1", "user", "tools"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        execution: null,
        open: null,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "interrupted:user", calls: ["call_1 shell error (stopped by the user)", "call_2 shell error"] }, { id: "s1", origin: "interrupt" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

/** What the child had said when it was stopped. */
export const CHILD_WORDS = "Looking at a.ts."
const stoppedChild = renderChildResult(OTHER, { outcome: "stopped", answer: CHILD_WORDS, detail: "It was stopped before it finished: the user stopped this call.", steps: 0, toolCalls: 1, usage: null }, null, false)

export const subagentCallStopped: Scenario = {
  title: "The user stops a subagent call: the child is interrupted and the call says so",
  description:
    "A call that waits for a subagent is stopped like any call. Its signal fires, and the session interrupts the child as the child's own user would: the child winds down by the usual rules and its turn ends as interrupted in its own log. In the parent, `spawn.ended` records that the work was `stopped`, and the call settles as `error` with a result that says the subagent did not finish because the user stopped this call, and quotes its last words. The parent's turn goes on: the model reads that result and decides what to do. The child's conversation stays, so a follow-up can still be sent to it.",
  provider: "step 1 calls subagent; the child has said what it is doing and is reading a file when the user stops the call; step 2 answers",
  spawn: {},
  phases: [
    {
      label: "the child is started and runs",
      events: [...opening("Fix module a with a subagent."), stepStarted("a1"), called("a1", "call_1", "subagent", '{"task":"Fix module a"}'), toolStartedAs("a1", "call_1", "exec"), spawnStarted("bg_1", "a1", "call_1", "subagent")],
      expect: { open: "a1" },
    },
    {
      label: "the user stops the call; the child is interrupted and its end is the call's result",
      events: [
        cancelRequested("a1", "call_1"),
        // The child's one model call had finished (it asked for the read), so its cost is on record.
        spawnEnded("bg_1", "stopped", "It was stopped before it finished: the user stopped this call.", { steps: 1 }),
        settled("a1", "call_1", "error", stoppedChild),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "You stopped the subagent before it changed anything. Module a is not fixed."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: { execution: null, ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: ["call_1 subagent error (stopped by the user)"] }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"] },
    },
  ],
}

export const callStopScenarios = [oneCommandStopped, stoppedCallReportsNothing, readFinishesAnyway, stoppedThenInterrupted, subagentCallStopped]

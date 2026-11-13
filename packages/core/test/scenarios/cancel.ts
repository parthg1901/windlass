/**
 * Cancel by the user at each moment of a turn.
 *
 * Every scenario runs the same way (cancel rules 2, 3, 4 and 6): the cancel is
 * made durable at once with `execution.interrupt_requested`, before anything
 * is stopped; visible partial text is kept; every recorded call is settled
 * exactly once; the open step, if any, gets exactly one terminal event,
 * `step.failed` with `interrupted:user`; the interrupt marker follows it; and
 * `execution.interrupted` with reason `user` releases the claim. Between the
 * request and the release the reducer accepts nothing that would carry the
 * work on.
 */
import {
  EFFECT_UNKNOWN,
  INTERRUPTED_READ,
  NOT_STARTED,
  type Scenario,
  called,
  executionFailed,
  executionInterrupted,
  executionResumed,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  opening,
  rateLimited,
  ran,
  retryScheduled,
  say,
  settled,
  serverError,
  stepCrashed,
  stepEnded,
  stepInterrupted,
  stepProviderFailed,
  stepStarted,
  synthetic,
  think,
  toolStarted,
} from "./script.ts"

/** After a user cancel the claim is gone: nothing can resume it. */
const released = { execution: null, open: null, inbox: [] }

export const whileTextStreams: Scenario = {
  title: "Cancel while text is streaming",
  description:
    "The model has finished a reasoning item and is half-way through its answer when the user presses stop. The half-written sentence the user already saw is kept, written as a `text.ended` with the text so far. Reasoning that was still streaming would be dropped, because partial reasoning is never recorded. The model is told on its next request that its response was cut short.",
  provider: "streams a complete reasoning item, then text deltas \"Let me lo\"; the abort signal fires and the stream stops with no terminal event",
  phases: [
    {
      label: "the model is streaming",
      events: [...opening(), stepStarted("a1"), think("a1", "Read the test first.")],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0 } },
    },
    {
      label: "the user cancels: the request is durable before anything stops",
      events: [interruptRequested("user")],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0, interrupting: "user" } },
      rejects: [
        { event: think("a1", "One more thought."), code: "invalid_transition", why: "no new model output is recorded after the cancel, only the visible partial text" },
        { event: called("a1", "call_1", "read", "{}"), code: "invalid_transition", why: "no tool call is recorded after the cancel" },
        { event: stepEnded("a1"), code: "invalid_transition", why: "a step that was open when the cancel arrived ends as interrupted, not as completed" },
        { event: stepProviderFailed("a1", serverError), code: "invalid_transition", why: "the step ends as interrupted even if the provider failed at the same moment" },
        { event: stepCrashed("a1"), code: "invalid_transition", why: "the cancel is durable, so recovery closes the step as interrupted, not as crashed" },
        { event: stepInterrupted("a1", "shutdown"), code: "invalid_transition", why: "the step is interrupted for the reason that was requested" },
        { event: interruptRequested("shutdown"), code: "invalid_transition", why: "the first interrupt wins, as it does on the abort token" },
      ],
    },
    {
      label: "flush the visible text and close the step",
      events: [say("a1", "Let me lo"), stepInterrupted("a1", "user")],
      rejects: [
        {
          event: stepStarted("a2"),
          code: "invalid_transition",
          why: "an interrupted step must be followed by the marker and execution.interrupted, not by another step",
        },
        { event: executionInterrupted("user"), code: "invalid_transition", why: "the interrupt marker comes first: the model must be told its response was cut short" },
        { event: synthetic("s1", "empty_response", "Continue."), code: "invalid_transition", why: "the only harness message while winding down is the interrupt marker" },
        { event: executionSucceeded(), code: "invalid_transition", why: "an interrupted execution does not succeed" },
        { event: executionFailed("gave up"), code: "invalid_transition", why: "an interrupted execution ends as interrupted, not as failed" },
      ],
    },
    {
      label: "tell the model",
      events: [interruptMarker("s1", "user")],
      rejects: [
        { event: executionInterrupted("shutdown"), code: "invalid_transition", why: "the user cancelled, so the claim is released, not kept for the next start" },
        { event: stepStarted("a2"), code: "invalid_transition", why: "the marker does not end the interrupt; only execution.interrupted does" },
      ],
    },
    {
      label: "release the claim",
      events: [executionInterrupted("user")],
      expect: {
        ...released,
        ui: [
          { id: "u1" },
          { id: "a1", kind: "assistant", status: "failed", error: "interrupted:user", text: "Let me lo", calls: [] },
          { id: "s1", kind: "synthetic", origin: "interrupt" },
        ],
        history: ["u1", "a1", "s1"],
      },
      rejects: [
        {
          event: executionResumed(),
          code: "not_found",
          why: "a user interrupt releases the claim, so unlike a shutdown there is nothing to resume",
        },
      ],
    },
  ],
}

export const whileToolArgumentsStream: Scenario = {
  title: "Cancel while a tool call's arguments are streaming",
  description:
    "The model has finished one tool call and is streaming the arguments of a second when the user cancels. A call starts the moment its arguments finish streaming, so the first read already ran and keeps its result. The second call never finished streaming, so it is never recorded and never runs; its partial arguments are dropped.",
  provider: "streams text, one complete tool call (call_1), then argument deltas for call_2; aborted before call_2 ends",
  phases: [
    {
      label: "the model is streaming the second call",
      events: [
        ...opening(),
        stepStarted("a1"),
        say("a1", "I'll read both files."),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", calls: ["call_1 read running"] }] },
      rejects: [
        {
          event: stepInterrupted("a1", "user"),
          code: "invalid_transition",
          why: "a step ends as interrupted only after the interrupt was requested, and only once call_1 is settled",
        },
      ],
    },
    {
      label: "the first call has its result while the second is still streaming",
      events: [settled("a1", "call_1", "success", "export const a = 1")],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", calls: ["call_1 read success"] }] },
    },
    {
      label: "the user cancels",
      events: [
        interruptRequested("user"),
        stepInterrupted("a1", "user"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", text: "I'll read both files.", calls: ["call_1 read success"] },
          { id: "s1" },
        ],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const whileCallWaitsAndArgumentsStream: Scenario = {
  title: "Cancel while a call waits behind a command and the response streams",
  description:
    "The model asks for a command, then for a write, and is streaming the arguments of a third call when the user cancels. The command started the moment its arguments were in; the write waits for it, because a command could change the file the write was decided about. The cancel stops the command, which settles with what it printed; the write was recorded but never started, so it settles as `not_started`; the third call never finished streaming, so it is never recorded and never runs.",
  provider: "streams text, a shell call (call_1), a write call (call_2), then argument deltas for call_3; the command is still running and the response still streaming when the abort fires",
  phases: [
    {
      label: "the command runs, the write waits for it, and the model streams a third call",
      events: [
        ...opening("Run the migration, note it in the changelog and show the schema."),
        stepStarted("a1"),
        say("a1", "I'll run the migration, note it and show the schema."),
        called("a1", "call_1", "shell", '{"command":"bun run migrate"}'),
        toolStarted("a1", "call_1", "shell"),
        called("a1", "call_2", "write", '{"path":"CHANGELOG.md","content":"Added an index."}'),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", calls: ["call_1 shell running", "call_2 write pending"] }] },
    },
    {
      label: "the user cancels; the command returns its output so far and the write never starts",
      events: [
        interruptRequested("user"),
        settled("a1", "call_1", "error", "Stopped by the user after 2 s. Output so far:\nmigrating\n"),
        settled("a1", "call_2", "not_started", NOT_STARTED),
        stepInterrupted("a1", "user"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", text: "I'll run the migration, note it and show the schema.", calls: ["call_1 shell error", "call_2 write not_started"] },
          { id: "s1" },
        ],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const whileOneToolRuns: Scenario = {
  title: "Cancel while one tool is running",
  description:
    "A shell command is running when the user cancels. The shell kills the process group, waits its bounded grace period, and returns the output so far. Because an outcome was observed (it was stopped, and here is what it printed), the call settles as `error` with that output, not as `effect_unknown`.",
  provider: "the response finishes with one shell call; the command is still running when the abort fires",
  phases: [
    {
      label: "the command is running",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1", "shell"),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell running"] }] },
    },
    {
      label: "the user cancels; the shell returns its output so far",
      events: [
        interruptRequested("user"),
        settled("a1", "call_1", "error", "Stopped by the user after 4 s. Output so far:\n12 pass\n"),
        stepInterrupted("a1", "user", "tools"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", calls: ["call_1 shell error"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const whileParallelToolsRunOneDone: Scenario = {
  title: "Cancel while two parallel tools run and one has finished",
  description:
    "Two calls run at once. The read started as soon as its arguments ended and settled with its result before the shell call had finished streaming; the shell command is still running when the user cancels. The finished call keeps its result, the running one settles once with the output it observed, and only then does the step close.",
  provider: "step 1 finishes with a read and a shell call; the read finishes, the shell is still running at the abort",
  phases: [
    {
      label: "one call is done, one is running",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
        settled("a1", "call_1", "success", "export const a = 1"),
        called("a1", "call_2", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_2", "shell"),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read success", "call_2 shell running"] }] },
      rejects: [
        {
          event: settled("a1", "call_1", "error", "Stopped by the user."),
          code: "invalid_transition",
          why: "a call settles exactly once: the finished read keeps its result",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [
        interruptRequested("user"),
        settled("a1", "call_2", "error", "Stopped by the user after 2 s. Output so far:\n3 pass\n"),
        stepInterrupted("a1", "user", "tools"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", calls: ["call_1 read success", "call_2 shell error"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const beforeSideEffectReports: Scenario = {
  title: "Cancel before a started side-effecting tool reports anything",
  description:
    "A write has started (its `tool.started` is durable) and the user cancels before it returns anything. Nobody observed whether the file was written, so the call settles as `effect_unknown` and the model is told to check before repeating it. It can never be `not_started`: once started, a side effect may have happened.",
  provider: "step 1 finishes with one write call; the abort fires right after the tool starts and the tool returns nothing",
  phases: [
    {
      label: "the write has started",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "write", '{"path":"a.ts","content":"export const a = 2"}'),
        toolStarted("a1", "call_1", "write"),
      ],
      rejects: [
        {
          event: settled("a1", "call_1", "not_started", NOT_STARTED),
          code: "invalid_transition",
          why: "a started call may have had its effect; it cannot claim it never started",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [
        interruptRequested("user"),
        settled("a1", "call_1", "effect_unknown", EFFECT_UNKNOWN),
        stepInterrupted("a1", "user", "tools"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", calls: ["call_1 write effect_unknown"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const beforeReadReports: Scenario = {
  title: "Cancel before a started read-only tool reports anything",
  description:
    "Same moment as the previous scenario, but the tool only reads. A read has no side effect, so there is nothing unknown about the workspace: the call settles as `error`, and the model may simply call it again.",
  provider: "step 1 finishes with one read call; the abort fires right after the tool starts and the tool returns nothing",
  phases: [
    {
      label: "the read has started",
      events: [...opening(), stepStarted("a1"), called("a1", "call_1", "read", '{"path":"a.ts"}'), toolStarted("a1", "call_1", "read")],
      rejects: [
        {
          event: settled("a1", "call_1", "effect_unknown", EFFECT_UNKNOWN),
          code: "invalid_transition",
          why: "the call started with effect class read, which has no side effect, so there is nothing unknown about it",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [
        interruptRequested("user"),
        settled("a1", "call_1", "error", INTERRUPTED_READ),
        stepInterrupted("a1", "user", "tools"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", calls: ["call_1 read error"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const betweenSteps: Scenario = {
  title: "Cancel while waiting between steps",
  description:
    "The first step ended and its tool results are durable; the next model call has not started. No step is open, so no step event is written: the cancel is only the marker and the release. Each step that ran still has exactly one terminal event.",
  provider: "step 1 finishes with one read call that succeeds; the abort fires before step 2 is requested",
  phases: [
    {
      label: "between steps",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...ran("a1", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { open: null, execution: { status: "running", crashResumes: 0 } },
      rejects: [
        {
          event: stepInterrupted("a1", "user"),
          code: "invalid_transition",
          why: "a1 already has its terminal event; a step ends exactly once",
        },
        {
          event: executionInterrupted("user"),
          code: "invalid_transition",
          why: "an execution ends as interrupted only after the interrupt was requested",
        },
        {
          event: executionSucceeded(),
          code: "invalid_transition",
          why: "the model never saw call_1's result, so the execution did not run to completion",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [interruptRequested("user"), interruptMarker("s1", "user"), executionInterrupted("user")],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: ["call_1 read success"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const duringRetryDelay: Scenario = {
  title: "Cancel while waiting to retry",
  description:
    "The first attempt failed with a rate limit before any output, so the retry runs under the same message and the loop is sleeping for the retry-after delay. The step is still open. The user cancels during the delay: the step closes as interrupted (not as a provider failure), and the scheduled attempt never runs.",
  provider: "attempt 1 fails with rate_limit (retry-after 3 s) before any output; the abort fires during the delay",
  phases: [
    {
      label: "waiting to retry",
      events: [...opening(), stepStarted("a1"), retryScheduled("a1", 2, rateLimited, 3000)],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", attempt: 2 }] },
    },
    {
      label: "the user cancels during the delay",
      events: [interruptRequested("user")],
      rejects: [
        { event: retryScheduled("a1", 3, rateLimited), code: "invalid_transition", why: "nothing is retried once the user cancelled" },
      ],
    },
    {
      label: "the step closes as interrupted",
      events: [stepInterrupted("a1", "user"), interruptMarker("s1", "user"), executionInterrupted("user")],
      expect: {
        ...released,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", attempt: 2, error: "interrupted:user", text: "" }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
      rejects: [
        {
          event: retryScheduled("a1", 3, rateLimited),
          code: "invalid_transition",
          why: "a step that the user interrupted is not retried",
        },
      ],
    },
  ],
}

export const cancelScenarios = [
  whileTextStreams,
  whileToolArgumentsStream,
  whileCallWaitsAndArgumentsStream,
  whileOneToolRuns,
  whileParallelToolsRunOneDone,
  beforeSideEffectReports,
  beforeReadReports,
  betweenSteps,
  duringRetryDelay,
]

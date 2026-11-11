/**
 * Cancel by the user at each moment of a turn.
 *
 * Every scenario ends the same way (cancel rules 3, 4 and 6): visible partial
 * text is kept; every recorded call is settled exactly once; the open step, if
 * any, gets exactly one terminal event, `step.failed` with
 * `interrupted:user`; the interrupt marker follows it; and
 * `execution.interrupted` with reason `user` releases the claim.
 */
import {
  EFFECT_UNKNOWN,
  INTERRUPTED_READ,
  NOT_STARTED,
  type Scenario,
  called,
  executionInterrupted,
  executionResumed,
  executionSucceeded,
  interruptMarker,
  opening,
  rateLimited,
  ran,
  retryScheduled,
  say,
  settled,
  stepEnded,
  stepInterrupted,
  stepStarted,
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
      expect: { open: "a1", execution: { status: "running", resumes: 0 } },
    },
    {
      label: "the user cancels: flush the visible text and close the step",
      events: [say("a1", "Let me lo"), stepInterrupted("a1", "user")],
      gaps: [
        {
          gap: "G5",
          event: stepStarted("a2"),
          why: "an interrupted step must be followed by the marker and execution.interrupted, not by another step",
        },
      ],
    },
    {
      label: "tell the model and release the claim",
      events: [interruptMarker("s1", "user"), executionInterrupted("user")],
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
    "The model has finished one tool call and is streaming the arguments of a second when the user cancels. Tools run only after the response finishes, so the first call is recorded but has not started: it settles as `not_started`. The second call never finished streaming, so it is never recorded at all; its partial arguments are dropped.",
  provider: "streams text, one complete tool call (call_1), then argument deltas for call_2; aborted before call_2 ends",
  phases: [
    {
      label: "the model is streaming the second call",
      events: [
        ...opening(),
        stepStarted("a1"),
        say("a1", "I'll read both files."),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", calls: ["call_1 read pending"] }] },
      rejects: [
        {
          event: stepInterrupted("a1", "user"),
          code: "invalid_transition",
          why: "the step cannot end while call_1 is unsettled: settle every recorded call first",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [
        settled("a1", "call_1", "not_started", NOT_STARTED),
        stepInterrupted("a1", "user"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ...released,
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", text: "I'll read both files.", calls: ["call_1 read not_started"] },
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
        settled("a1", "call_1", "error", "Stopped by the user after 4 s. Output so far:\n12 pass\n"),
        stepInterrupted("a1", "user"),
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
    "Two calls run at once. The read already settled with its result; the shell command is still running when the user cancels. The finished call keeps its result, the running one settles once with the output it observed, and only then does the step close.",
  provider: "step 1 finishes with a read and a shell call; the read finishes, the shell is still running at the abort",
  phases: [
    {
      label: "one call is done, one is running",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        called("a1", "call_2", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1", "read"),
        toolStarted("a1", "call_2", "shell"),
        settled("a1", "call_1", "success", "export const a = 1"),
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
        settled("a1", "call_2", "error", "Stopped by the user after 2 s. Output so far:\n3 pass\n"),
        stepInterrupted("a1", "user"),
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
        settled("a1", "call_1", "effect_unknown", EFFECT_UNKNOWN),
        stepInterrupted("a1", "user"),
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
        settled("a1", "call_1", "error", INTERRUPTED_READ),
        stepInterrupted("a1", "user"),
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
      expect: { open: null, execution: { status: "running", resumes: 0 } },
      rejects: [
        {
          event: stepInterrupted("a1", "user"),
          code: "invalid_transition",
          why: "a1 already has its terminal event; a step ends exactly once",
        },
      ],
      gaps: [
        {
          gap: "G6",
          event: executionSucceeded(),
          why: "the model never saw call_1's result, so the execution did not run to completion",
        },
      ],
    },
    {
      label: "the user cancels",
      events: [interruptMarker("s1", "user"), executionInterrupted("user")],
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
      label: "the user cancels",
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
  whileOneToolRuns,
  whileParallelToolsRunOneDone,
  beforeSideEffectReports,
  beforeReadReports,
  betweenSteps,
  duringRetryDelay,
]

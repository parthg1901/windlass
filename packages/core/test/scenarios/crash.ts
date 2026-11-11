/**
 * Crash recovery: the process dies with the claim held. At the next start the
 * log shows `execution` still `running`. Recovery, before anything else:
 * settles every orphaned call durably (cancel rule 4), closes the open step
 * as `crashed`, appends the interrupt marker, and records `execution.resumed`
 * (the durable resume count) — or, at the resume cap, `execution.failed`.
 */
import {
  CRASH_EFFECT_UNKNOWN,
  CRASH_READ,
  NOT_STARTED,
  RESUME_CAP,
  type Scenario,
  called,
  executionFailed,
  executionResumed,
  executionSucceeded,
  interruptMarker,
  opening,
  ran,
  say,
  settled,
  stepCrashed,
  stepEnded,
  stepStarted,
  toolStarted,
} from "./script.ts"

const crashedClaim = { execution: { status: "running" as const, resumes: 0 } }

export const crashWhileStreaming: Scenario = {
  title: "The process dies while the model is streaming",
  description:
    "One text item had ended and was durable; the next was streaming. The streamed deltas were never durable, so they are simply gone. Recovery closes the step as crashed (its completed text stays), tells the model the response was cut short, records the resume and runs a fresh step.",
  provider: "streams one complete text item, then deltas of a second; the process is killed; after restart the new step answers",
  phases: [
    {
      label: "the process dies mid-stream",
      events: [...opening(), stepStarted("a1"), say("a1", "Reading the test first.")],
      expect: { ...crashedClaim, open: "a1" },
      rejects: [
        {
          event: executionResumed(),
          code: "invalid_transition",
          why: "recovery closes the crashed step before it records the resume",
        },
      ],
    },
    {
      label: "at next start-up",
      events: [stepCrashed("a1"), interruptMarker("s1", "crash"), executionResumed()],
      expect: {
        execution: { status: "running", resumes: 1 },
        open: null,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "crashed", text: "Reading the test first." }, { id: "s1", origin: "interrupt" }],
        history: ["u1", "a1", "s1"],
      },
    },
    {
      label: "the loop carries on",
      events: [stepStarted("a2"), say("a2", "The expectation is wrong."), stepEnded("a2"), executionSucceeded()],
      expect: { history: ["u1", "a1", "s1", "a2"], execution: null },
    },
  ],
}

export const crashWhileReadRuns: Scenario = {
  title: "The process dies while a read-only tool is running",
  description:
    "A read had started. A read changes nothing, so recovery settles it as `error` with a note that it is safe to repeat; the model calls it again in the resumed step.",
  provider: "step 1 finishes with a read call; the process is killed while it runs; after restart the model reads again and answers",
  phases: [
    {
      label: "the process dies while the read runs",
      events: [...opening(), stepStarted("a1"), called("a1", "call_1", "read", '{"path":"a.ts"}'), toolStarted("a1", "call_1")],
      expect: { ...crashedClaim, open: "a1" },
      rejects: [
        {
          event: settled("a1", "call_1", "not_started", NOT_STARTED),
          code: "invalid_transition",
          why: "a call that was started cannot be settled as not started",
        },
      ],
    },
    {
      label: "at next start-up",
      events: [settled("a1", "call_1", "error", CRASH_READ), stepCrashed("a1"), interruptMarker("s1", "crash"), executionResumed()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "crashed", calls: ["call_1 read error"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
        execution: { status: "running", resumes: 1 },
      },
    },
    {
      label: "the loop carries on",
      events: [
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "a is 1."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: { history: ["u1", "a1", "s1", "a2", "a3"], execution: null },
    },
  ],
}

export const crashWhileSideEffectRuns: Scenario = {
  title: "The process dies while a side-effecting tool is running",
  description:
    "A migration command had started and a second call was recorded but not yet started. Nobody knows whether the migration ran, so recovery settles it as `effect_unknown`; the pending call provably never ran and settles as `not_started`. In the resumed step the model checks the state before doing anything else.",
  provider: "step 1 finishes with a shell call and a read call; the shell starts, the process is killed; after restart the model inspects, then answers",
  phases: [
    {
      label: "the process dies while the migration runs",
      events: [
        ...opening("Run the migration and show the schema."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun run migrate"}'),
        called("a1", "call_2", "read", '{"path":"schema.sql"}'),
        toolStarted("a1", "call_1"),
      ],
      expect: { ...crashedClaim, ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell running", "call_2 read pending"] }] },
    },
    {
      label: "at next start-up",
      events: [
        settled("a1", "call_1", "effect_unknown", CRASH_EFFECT_UNKNOWN),
        settled("a1", "call_2", "not_started", NOT_STARTED),
        stepCrashed("a1"),
        interruptMarker("s1", "crash"),
        executionResumed(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", error: "crashed", calls: ["call_1 shell effect_unknown", "call_2 read not_started"] },
          { id: "s1" },
        ],
        history: ["u1", "a1", "s1"],
        execution: { status: "running", resumes: 1 },
      },
    },
    {
      label: "the model inspects before repeating",
      events: [
        stepStarted("a2"),
        ...ran("a2", "call_1", "shell", '{"command":"bun run migrate:status"}', "applied: 0007_add_index"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "The migration had already been applied."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: { history: ["u1", "a1", "s1", "a2", "a3"], execution: null },
    },
  ],
}

export const crashAfterToolBeforeResult: Scenario = {
  title: "The process dies after a tool finished but before its result was written",
  description:
    "The write completed on disk, but the process died before `tool.settled` was appended. The log is byte-for-byte the same as a crash while the tool was still running, so recovery must do the same thing: the result is lost and the outcome is `effect_unknown`. This is why the start is made durable before running, and why the model is asked to check rather than told it failed.",
  provider: "step 1 finishes with a write call; the write finishes; the process is killed before the result is recorded",
  phases: [
    {
      label: "the write finished, its result was not written",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "write", '{"path":"a.ts","content":"export const a = 2"}'),
        toolStarted("a1", "call_1"),
      ],
      expect: { ...crashedClaim, ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write running"] }] },
    },
    {
      label: "at next start-up",
      events: [
        settled("a1", "call_1", "effect_unknown", CRASH_EFFECT_UNKNOWN),
        stepCrashed("a1"),
        interruptMarker("s1", "crash"),
        executionResumed(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "failed", calls: ["call_1 write effect_unknown"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
        execution: { status: "running", resumes: 1 },
      },
    },
  ],
}

export const crashBetweenSteps: Scenario = {
  title: "The process dies between steps",
  description:
    "The step ended and its results are durable; the next model call had not started. Nothing was lost, so recovery has nothing to settle, no step to close and nothing to tell the model: it records the resume and the loop continues with the next step.",
  provider: "step 1 finishes with a read call that succeeds; the process is killed before step 2; after restart step 2 answers",
  phases: [
    {
      label: "the process dies at the boundary",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...ran("a1", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { ...crashedClaim, open: null },
    },
    {
      label: "at next start-up",
      events: [executionResumed(), stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2"), executionSucceeded()],
      expect: { history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

export const crashBeforeRelease: Scenario = {
  title: "The process dies after the answer, before the claim was released",
  description:
    "The last step ended with `stop` and nothing waits in the inbox, so the execution was finished in all but name. Recovery releases the claim directly; there is no work to resume.",
  provider: "one step answers with stop; the process is killed before the claim is released",
  phases: [
    {
      label: "the answer is durable, the claim is not released",
      events: [...opening(), stepStarted("a1"), say("a1", "Done."), stepEnded("a1")],
      expect: crashedClaim,
    },
    {
      label: "at next start-up",
      events: [executionSucceeded()],
      expect: { history: ["u1", "a1"], execution: null },
    },
  ],
}

export const resumeCap: Scenario = {
  title: `The resume cap: the same execution crashes ${RESUME_CAP + 1} times`,
  description: `Something in this turn kills the process every time (say, a tool that exhausts memory). Each start-up recovers and resumes, and \`execution.resumed\` events count the attempts durably. After ${RESUME_CAP} resumes, the next start-up closes the crashed step and fails the execution instead of resuming it again.`,
  provider: "every step is killed mid-stream",
  phases: [
    {
      label: `${RESUME_CAP} crashes, each recovered`,
      events: [
        ...opening(),
        ...Array.from({ length: RESUME_CAP }, (_, index) => [
          stepStarted(`a${index + 1}`),
          stepCrashed(`a${index + 1}`),
          interruptMarker(`s${index + 1}`, "crash"),
          executionResumed(),
        ]).flat(),
        stepStarted(`a${RESUME_CAP + 1}`),
      ],
      expect: { execution: { status: "running", resumes: RESUME_CAP }, open: `a${RESUME_CAP + 1}` },
    },
    {
      label: "the next start-up gives up",
      events: [
        stepCrashed(`a${RESUME_CAP + 1}`),
        interruptMarker(`s${RESUME_CAP + 1}`, "crash"),
        executionFailed(`Gave up after the harness restarted ${RESUME_CAP} times during this turn.`),
      ],
      expect: {
        execution: null,
        open: null,
        history: ["u1", "a1", "s1", "a2", "s2", "a3", "s3", "a4", "s4"],
      },
    },
  ],
}

export const crashScenarios = [
  crashWhileStreaming,
  crashWhileReadRuns,
  crashWhileSideEffectRuns,
  crashAfterToolBeforeResult,
  crashBetweenSteps,
  crashBeforeRelease,
  resumeCap,
]

/**
 * Graceful shutdown. Like a user interrupt, every call settles and the step
 * closes once; unlike it, the reason is `shutdown` and the claim is kept as
 * `suspended`, so the next start resumes the session instead of leaving it idle.
 */
import {
  type Scenario,
  called,
  deliver,
  enqueue,
  executionInterrupted,
  executionResumed,
  executionStarted,
  executionSucceeded,
  interruptMarker,
  opening,
  ran,
  say,
  settled,
  stepEnded,
  stepInterrupted,
  stepStarted,
  toolStarted,
} from "./script.ts"

export const shutdownMidStep: Scenario = {
  title: "A graceful shutdown mid-step",
  description:
    "The user quits the app while a test run is in progress. The shell is stopped the same way as on a cancel and reports its output so far; the step closes as interrupted for `shutdown`; the model is told; the claim is kept as suspended. While suspended nothing new can start or be delivered. At the next start the execution is resumed and the turn continues where it stopped.",
  provider: "step 1 finishes with a shell call; the process receives SIGTERM while it runs; after restart the model reruns the tests and answers",
  phases: [
    {
      label: "the shutdown stops the step",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1"),
        settled("a1", "call_1", "error", "Stopped because the harness was shutting down. Output so far:\n12 pass\n"),
        stepInterrupted("a1", "shutdown"),
        interruptMarker("s1", "shutdown"),
      ],
      gaps: [
        {
          gap: "G5",
          event: executionInterrupted("user"),
          why: "the step was interrupted for shutdown, so the execution must be too, keeping the claim",
        },
      ],
    },
    {
      label: "the claim is kept",
      events: [executionInterrupted("shutdown"), enqueue("u2", "Are you there?")],
      expect: {
        execution: { status: "suspended", resumes: 0 },
        open: null,
        inbox: ["u2"],
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "interrupted:shutdown", calls: ["call_1 shell error"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
      rejects: [
        { event: deliver("u2"), code: "invalid_transition", why: "a suspended execution delivers nothing until it is resumed" },
        { event: executionStarted("exe_2"), code: "invalid_transition", why: "the suspended claim still belongs to exe_1" },
        { event: stepStarted("a2"), code: "invalid_transition", why: "no step runs under a suspended claim" },
      ],
    },
    {
      label: "the next start resumes the session",
      events: [
        executionResumed(),
        deliver("u2"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "shell", '{"command":"bun test"}', "14 pass, 0 fail"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "Yes. All 14 tests pass."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: {
        history: ["u1", "a1", "s1", "u2", "a2", "a3"],
        execution: null,
        inbox: [],
      },
    },
  ],
}

export const shutdownBetweenSteps: Scenario = {
  title: "A graceful shutdown between steps",
  description:
    "No step is open, so nothing needs closing and nothing was cut short: no marker, only the suspended claim. The next start resumes and runs the next step.",
  provider: "step 1 finishes with a read call that succeeds; SIGTERM arrives before step 2",
  phases: [
    {
      label: "shutdown at the boundary",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...ran("a1", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a1", "tool_calls"),
        executionInterrupted("shutdown"),
      ],
      expect: { execution: { status: "suspended", resumes: 0 }, history: ["u1", "a1"] },
    },
    {
      label: "the next start resumes",
      events: [executionResumed(), stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2"), executionSucceeded()],
      expect: { history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

export const shutdownScenarios = [shutdownMidStep, shutdownBetweenSteps]

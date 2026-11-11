/**
 * Graceful shutdown. Like a user interrupt, every call settles and the step
 * closes once; unlike it, the reason is `shutdown` and the claim is kept as
 * `suspended`, so the next start resumes the session instead of leaving it idle.
 */
import {
  CRASH_EFFECT_UNKNOWN,
  RESUME_CAP,
  type Scenario,
  called,
  deliver,
  enqueue,
  executionInterrupted,
  executionResumed,
  executionStarted,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  opening,
  ran,
  say,
  settled,
  stepCrashed,
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
        toolStarted("a1", "call_1", "shell"),
        interruptRequested("shutdown"),
        settled("a1", "call_1", "error", "Stopped because the harness was shutting down. Output so far:\n12 pass\n"),
        stepInterrupted("a1", "shutdown"),
        interruptMarker("s1", "shutdown"),
      ],
      rejects: [
        {
          event: executionInterrupted("user"),
          code: "invalid_transition",
          why: "the step was interrupted for shutdown, so the execution must be too, keeping the claim",
        },
      ],
    },
    {
      label: "the claim is kept",
      events: [executionInterrupted("shutdown"), enqueue("u2", "Are you there?")],
      expect: {
        execution: { status: "suspended", crashResumes: 0 },
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
        interruptRequested("shutdown"),
        executionInterrupted("shutdown"),
      ],
      expect: { execution: { status: "suspended", crashResumes: 0 }, history: ["u1", "a1"] },
    },
    {
      label: "the next start resumes",
      events: [executionResumed(), stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2"), executionSucceeded()],
      expect: { history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

export const shutdownResumesAreNotCrashes: Scenario = {
  title: "Shutdown resumes do not use up the crash-resume cap",
  description: `A long turn spans two clean restarts of the app, and then the process really crashes. The two resumes after a shutdown are not counted, so the crash is the first of the ${RESUME_CAP} the cap allows, and the turn is resumed. Only a resume that finds the claim still \`running\`, which means the previous process died, counts.`,
  provider: "three steps that each call a tool; the app is quit and restarted twice between steps, then killed in the middle of the fourth step",
  phases: [
    {
      label: "two clean restarts between steps",
      events: [
        ...opening(),
        ...["a1", "a2"].flatMap((id) => [
          stepStarted(id),
          ...ran(id, "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
          stepEnded(id, "tool_calls"),
          interruptRequested("shutdown"),
          executionInterrupted("shutdown"),
          executionResumed(),
        ]),
      ],
      expect: { execution: { status: "running", crashResumes: 0 }, open: null },
    },
    {
      label: "the process is killed mid-step",
      events: [stepStarted("a3"), say("a3", "Now the tests.")],
      expect: { execution: { status: "running", crashResumes: 0 }, open: "a3" },
    },
    {
      label: "at next start-up the crash is the first one counted",
      events: [stepCrashed("a3"), interruptMarker("s1", "crash"), executionResumed()],
      expect: {
        execution: { status: "running", crashResumes: 1 },
        open: null,
        history: ["u1", "a1", "a2", "a3", "s1"],
      },
    },
  ],
}

export const killedWhileShuttingDown: Scenario = {
  title: "The process is killed while it is shutting down",
  description:
    "The app is quit while a test run is in progress. The shutdown is made durable, the shell is asked to stop, and the process is killed before it has (a SIGKILL after the grace period). The log ends at the request. The next start does not treat this as a crash: it finishes the shutdown that was asked for, with the step interrupted for `shutdown` and the claim suspended, and then resumes as after any clean shutdown. The resume is not counted toward the crash-resume cap.",
  provider: "step 1 finishes with a shell call; SIGTERM arrives while it runs and SIGKILL follows before the command has stopped",
  phases: [
    {
      label: "the shutdown is requested, then the process is killed",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1", "shell"),
        interruptRequested("shutdown"),
      ],
      expect: { execution: { status: "running", crashResumes: 0, interrupting: "shutdown" }, open: "a1" },
      rejects: [
        { event: stepCrashed("a1"), code: "invalid_transition", why: "the shutdown was requested, so the step ends as interrupted for shutdown" },
        { event: executionResumed(), code: "invalid_transition", why: "the requested shutdown is finished before anything resumes" },
      ],
    },
    {
      label: "at next start-up the shutdown is finished, then the session resumes",
      events: [
        settled("a1", "call_1", "effect_unknown", CRASH_EFFECT_UNKNOWN),
        stepInterrupted("a1", "shutdown"),
        interruptMarker("s1", "shutdown"),
        executionInterrupted("shutdown"),
        executionResumed(),
      ],
      expect: {
        execution: { status: "running", crashResumes: 0 },
        open: null,
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "interrupted:shutdown", calls: ["call_1 shell effect_unknown"] }, { id: "s1" }],
        history: ["u1", "a1", "s1"],
      },
    },
  ],
}

export const shutdownScenarios = [shutdownMidStep, shutdownBetweenSteps, shutdownResumesAreNotCrashes, killedWhileShuttingDown]

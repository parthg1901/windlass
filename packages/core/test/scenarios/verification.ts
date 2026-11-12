/**
 * Verification: the session would go idle, and the harness runs the project's
 * configured checks itself before the execution may end as done. The result
 * is a fact in the log, not something the model says: `checks.started`, then
 * `checks.finished` with the evidence, appended together with what the gate
 * decided from it. A failing run is reported to the model as a harness
 * message and the turn goes on; it ends as done only with passing checks, or
 * as unresolved with the reason recorded.
 *
 * These sessions have snapshots: the workspace is recorded before input is
 * delivered, around the tools of a step that can change files and around a
 * run of checks, which is how the gate knows what changed.
 */
import {
  CHECK,
  CHECKS_CONFIG,
  type Scenario,
  called,
  deliver,
  enqueue,
  snap as snapshot,
  toolStarted,
  turnEnded,
  wrote as edited,
  checkReport,
  checksFailed,
  checksFinished,
  checksStarted,
  executionInterrupted,
  executionResumed,
  executionStarted as executionStartedAs,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  openingIn,
  passed,
  say,
  settled,
  snap,
  stepEnded,
  stepStarted,
  succeededWith,
  toolStartedAs,
  unresolved,
  wrote,
} from "./script.ts"

export const FILES = { "add.ts": "export const add = (a: number, b: number) => a - b\n", "add.test.ts": 'test("add", () => expect(add(1, 2)).toBe(3))\n' }
const setup = { files: FILES, config: CHECKS_CONFIG }
export const FIRST_FIX = '{"path":"add.ts","content":"export const add = (a: number, b: number) => b + a - 1\\n"}'
export const SECOND_FIX = '{"path":"add.ts","content":"export const add = (a: number, b: number) => a + b\\n"}'
export const ACKNOWLEDGEMENT = { checks: [CHECK.name], reason: "The test needs a fixture that is not in the repository." }

/** The turn up to the model's first "done": it changed add.ts (the workspace goes from w0 to w1) and answered. */
const firstAttempt = (answer: string) => [
  ...openingIn(),
  ...wrote("a1", FIRST_FIX, "Wrote add.ts", "w0", "w1"),
  stepStarted("a2"),
  say("a2", answer),
  stepEnded("a2"),
]
/** The checks run on workspace `id` and fail; the model is told. `r` is the report's message ID. */
const failingRun = (run: number, id: string, report: string) => [
  snap("checks_start", id),
  checksStarted(run),
  snap("checks_end", id),
  checksFinished(run, "failed", ["add.ts"]),
  checkReport(report),
]

export const checksPass: Scenario = {
  title: "The checks pass",
  description:
    "The model changes a file and says it is done. The harness records the workspace, runs the configured check and it passes, so the execution ends as done with the evidence. The check ran because `add.ts` differs between the snapshot the session started with and the one taken now.",
  provider: "step 1 calls write, step 2 answers; the `test` check exits 0",
  setup,
  phases: [
    {
      label: "the model changes a file and says it is done",
      events: firstAttempt("Fixed add."),
      expect: { execution: { status: "running", crashResumes: 0 }, open: null },
      rejects: [
        {
          event: checksFinished(1, "passed", ["add.ts"]),
          code: "invalid_transition",
          why: "a run of checks is started (durably) before it can have results",
        },
      ],
    },
    {
      label: "the harness runs the checks",
      events: [snap("checks_start", "w1"), checksStarted(1)],
      expect: { open: "checks:1" },
      rejects: [
        { event: executionSucceeded(), code: "invalid_transition", why: "the execution cannot end while its checks are running" },
        { event: stepStarted("a3"), code: "invalid_transition", why: "nothing else happens until the run has its terminal event" },
      ],
    },
    {
      label: "they pass, and the execution ends as done",
      events: [snap("checks_end", "w1"), checksFinished(1, "passed", ["add.ts"]), succeededWith(passed(1, ["add.ts"]))],
      expect: { execution: null, open: null, history: ["u1", "a1", "a2"] },
    },
  ],
}

export const checksFailThenPass: Scenario = {
  title: "The checks fail, the model fixes the code, and they pass",
  description:
    "The model's first fix leaves the test failing. The run and its report are appended together: the report is an ordinary harness message at the end of history, so the next request extends the previous one. The model fixes the code, says it is done again, and the second run passes.",
  provider: "write, answer; the check exits 1; then write, answer; the check exits 0",
  setup,
  phases: [
    {
      label: "the first run fails and the model is sent back",
      events: [...firstAttempt("Fixed add."), ...failingRun(1, "w1", "r1")],
      expect: {
        open: null,
        execution: { status: "running", crashResumes: 0 },
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2", text: "Fixed add." }, { id: "r1", origin: "check_report" }],
        history: ["u1", "a1", "a2", "r1"],
      },
      rejects: [
        { event: executionSucceeded(), code: "invalid_transition", why: "the report is unanswered: the model has to act on it or say that it cannot" },
      ],
    },
    {
      label: "the model fixes the code and says it is done again",
      events: [...wrote("a3", SECOND_FIX, "Wrote add.ts", "w1", "w2"), stepStarted("a4"), say("a4", "Now it adds."), stepEnded("a4")],
    },
    {
      label: "the second run passes",
      events: [snap("checks_start", "w2"), checksStarted(2), snap("checks_end", "w2"), checksFinished(2, "passed", ["add.ts"]), succeededWith(passed(2, ["add.ts"]))],
      expect: { execution: null, history: ["u1", "a1", "a2", "r1", "a3", "a4"] },
    },
  ],
}

export const checksFailUntilMaxRounds: Scenario = {
  title: "The checks still fail after the last allowed round",
  description:
    "`verify.maxRounds` is 1 here: the model is sent back once. Its second attempt fails too, so the execution ends, as unresolved: the event names the failing check and the reason (`max_rounds`) and carries the evidence. The last report is appended in the same transaction so that whoever continues the session sees it; it is the one harness message that may stay unanswered.",
  provider: "write, answer; the check exits 1; write, answer; the check exits 1 again",
  setup: { files: FILES, config: { ...CHECKS_CONFIG, verify: { maxRounds: 1 } } },
  phases: [
    {
      label: "the first run fails and the model is sent back",
      events: [...firstAttempt("Fixed add."), ...failingRun(1, "w1", "r1")],
    },
    {
      label: "the model tries again",
      events: [...wrote("a3", SECOND_FIX, "Wrote add.ts", "w1", "w2"), stepStarted("a4"), say("a4", "Now it adds."), stepEnded("a4")],
    },
    {
      label: "the second run fails too: the execution ends unresolved",
      events: [...failingRun(2, "w2", "r2"), succeededWith(unresolved("max_rounds", 2, ["add.ts"]))],
      expect: {
        execution: null,
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "r1" }, { id: "a3" }, { id: "a4" }, { id: "r2", origin: "check_report" }],
        history: ["u1", "a1", "a2", "r1", "a3", "a4", "r2"],
      },
    },
  ],
}

export const checksAcknowledged: Scenario = {
  title: "The model reports that it cannot make the checks pass",
  description:
    "After the report the model does not claim success: it calls `report_check_failure`, naming the check and the reason. That call is the acknowledgement; nothing is read out of its prose. The files did not change since the run, so the checks are not run again, and the execution ends as unresolved with what the model said.",
  provider: "write, answer; the check exits 1; the model calls report_check_failure and then answers",
  setup,
  phases: [
    {
      label: "the run fails and the model is sent back",
      events: [...firstAttempt("Fixed add."), ...failingRun(1, "w1", "r1")],
    },
    {
      label: "the model acknowledges the failure with the tool",
      events: [
        stepStarted("a3"),
        called("a3", "call_1", "report_check_failure", JSON.stringify(ACKNOWLEDGEMENT)),
        toolStartedAs("a3", "call_1", "read"),
        settled("a3", "call_1", "success", "Recorded as unresolved: test."),
        stepEnded("a3", "tool_calls"),
        stepStarted("a4"),
        say("a4", "The test cannot pass without the fixture."),
        stepEnded("a4"),
      ],
    },
    {
      label: "nothing changed since the run, so it stands: the execution ends unresolved",
      events: [snap("checks_start", "w1"), succeededWith(unresolved("acknowledged", 1, ["add.ts"], ACKNOWLEDGEMENT))],
      expect: { execution: null, history: ["u1", "a1", "a2", "r1", "a3", "a4"] },
    },
  ],
}

export const noChecksConfigured: Scenario = {
  title: "No checks are configured",
  description:
    "The project has no configuration file. The turn ends as done, and the event says that nothing was verified, so a client can tell this ending from one that rests on passing checks. The workspace is still recorded, so the turn can be undone.",
  provider: "step 1 calls write, step 2 answers",
  setup: { files: FILES },
  phases: [
    {
      label: "the turn",
      events: [...firstAttempt("Fixed add."), executionSucceeded()],
      expect: { execution: null, history: ["u1", "a1", "a2"] },
    },
  ],
}

export const cancelDuringChecks: Scenario = {
  title: "Cancel while the checks run",
  description:
    "The user cancels while the check command is running. The request is durable first; the command is stopped like a tool; the run is closed as interrupted, which says nothing about the code; the model is told and the claim is released. No result is recorded and nothing is reported.",
  provider: "write, answer; the check hangs until the user cancels",
  setup,
  phases: [
    {
      label: "the checks are running",
      events: [...firstAttempt("Fixed add."), snap("checks_start", "w1"), checksStarted(1)],
      expect: { open: "checks:1" },
    },
    {
      label: "the user cancels",
      events: [interruptRequested("user")],
      rejects: [
        { event: checksFinished(1, "passed", ["add.ts"]), code: "invalid_transition", why: "once an interrupt is requested the run can only be closed as interrupted" },
        { event: executionInterrupted("user"), code: "invalid_transition", why: "the run of checks is closed before the execution is" },
      ],
    },
    {
      label: "the run is closed and the execution released",
      events: [checksFailed(1, { kind: "interrupted", reason: "user" }), interruptMarker("s1", "user"), executionInterrupted("user")],
      expect: { execution: null, open: null, history: ["u1", "a1", "a2", "s1"] },
    },
  ],
}

export const crashDuringChecks: Scenario = {
  title: "The process dies while the checks run",
  description:
    "`checks.started` was durable and the process died before any result. Recovery closes the run as crashed and resumes the execution (a crash counts toward the resume cap, so a check that kills the harness cannot be run for ever). The loop finds the model's answer still standing and no result for it, runs the checks again, and ends the execution on what they show.",
  provider: "write, answer; the process is killed while the check runs; after restart the check exits 0 and the model is not called",
  setup,
  phases: [
    {
      label: "the process dies while the checks run",
      events: [...firstAttempt("Fixed add."), snap("checks_start", "w1"), checksStarted(1)],
      expect: { execution: { status: "running", crashResumes: 0 }, open: "checks:1" },
      rejects: [{ event: executionResumed(), code: "invalid_transition", why: "recovery closes the run before it records the resume" }],
    },
    {
      label: "at next start-up",
      events: [checksFailed(1, { kind: "crashed" }), executionResumed()],
      expect: { execution: { status: "running", crashResumes: 1 }, open: null },
    },
    {
      label: "the loop runs the checks again",
      events: [snap("checks_start", "w1"), checksStarted(1), snap("checks_end", "w1"), checksFinished(1, "passed", ["add.ts"]), succeededWith(passed(1, ["add.ts"]))],
      expect: { execution: null, history: ["u1", "a1", "a2"] },
    },
  ],
}

export const queuedWaitsForTheGate: Scenario = {
  title: "A queued message waits for the checks",
  description:
    "The user queues a follow-up while the model works. \"After this turn\" means after the turn is done, and done is what the verification gate says, so the gate runs before the queued message is delivered, exactly as it would before the execution ends. The first run fails and the model is sent back, with the follow-up still waiting. When the checks pass, the turn ends with that evidence (`turn.ended`) and the queued message is delivered in the same append. A steer is different: it redirects the model and is delivered at once, with no checks in between. Had the turn ended unresolved (acknowledged, out of rounds, report mode), `turn.ended` would say so and the follow-up would be delivered all the same.",
  provider: "write, answer; the check exits 1; then write, answer; the check exits 0; then the answer to the queued message",
  setup,
  phases: [
    {
      label: "the user queues a follow-up while the write runs; the model says it is done and the checks fail",
      events: [
        ...openingIn(),
        stepStarted("a1"),
        called("a1", "call_1", "write", FIRST_FIX),
        snapshot("step_start", "w0", "a1"),
        toolStarted("a1", "call_1", "write"),
        enqueue("u2", "Then add a test for negative numbers.", "queue"),
        settled("a1", "call_1", "success", "Wrote add.ts"),
        snapshot("step_end", "w1", "a1"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "Fixed add."),
        stepEnded("a2"),
        ...failingRun(1, "w1", "r1"),
      ],
      expect: { inbox: ["u2"], open: null, history: ["u1", "a1", "a2", "r1"] },
      rejects: [
        { event: deliver("u2"), code: "invalid_transition", why: "the turn has not ended: the checks failed and the model is sent back first" },
        { event: turnEnded(passed(1, ["add.ts"])), code: "invalid_transition", why: "the report is unanswered, so the turn is not over" },
      ],
    },
    {
      label: "the model fixes the code, the checks pass, the turn ends and the follow-up is delivered",
      events: [
        ...edited("a3", SECOND_FIX, "Wrote add.ts", "w1", "w2"),
        stepStarted("a4"),
        say("a4", "Now it adds."),
        stepEnded("a4"),
        snapshot("checks_start", "w2"),
        checksStarted(2),
        snapshot("checks_end", "w2"),
        checksFinished(2, "passed", ["add.ts"]),
        snapshot("delivery", "w2"),
        turnEnded(passed(2, ["add.ts"])),
        deliver("u2"),
      ],
      expect: { inbox: [], open: null, execution: { status: "running", crashResumes: 0 }, history: ["u1", "a1", "a2", "r1", "a3", "a4", "u2"] },
    },
    {
      label: "the follow-up is answered; nothing changed since the checks passed",
      events: [stepStarted("a5"), say("a5", "Added the test."), stepEnded("a5"), snapshot("checks_start", "w2"), succeededWith({ status: "not_needed" })],
      expect: { execution: null, history: ["u1", "a1", "a2", "r1", "a3", "a4", "u2", "a5"] },
    },
  ],
}

const HAND_EDIT = { path: "add.test.ts", content: 'test("add", () => expect(add(2, 2)).toBe(4))\n' }
export const HAND_EDITED = HAND_EDIT

export const questionAfterHandEdit: Scenario = {
  title: "A question after a hand edit runs no check; the next turn that changes a file checks it all",
  description:
    "The gate verifies a turn's own work. Between two turns the user edits a test by hand, then asks a question that the model answers without a tool. The workspace when that message was delivered (`delivery`) is the workspace when the turn ends, so the turn changed nothing and no check runs: the user is not shown `checks passed` for a turn that did nothing, and a hand edit that breaks a test does not send the model off to fix unfinished work it was not asked about. The edit is still unverified, and the ending says so (`not_needed` with `unverified`); the state checks are selected against does not move. The next turn changes a file, so the checks run, and they are selected from everything that is unverified: the evidence names the hand-edited file with the model's own.",
  provider: "turn 1 answers. Turn 2 (after the hand edit) answers. Turn 3 calls write, then answers; the `test` check exits 0",
  setup,
  phases: [
    {
      label: "a question: nothing changed, nothing to check",
      events: [...openingIn("What does add do?"), stepStarted("a1"), say("a1", "It subtracts, which looks like a bug."), stepEnded("a1"), snap("checks_start", "w0"), succeededWith({ status: "not_needed" })],
      expect: { execution: null, history: ["u1", "a1"] },
    },
    {
      label: "the user edits a test by hand, then asks again: the turn changed nothing, so no check runs, and the edit stays unverified",
      events: [
        enqueue("u2", "Is the test right now?"),
        executionStartedAs("exe_2"),
        snap("delivery", "w1"),
        deliver("u2"),
        stepStarted("a2"),
        say("a2", "It expects 4 for 2 + 2, which is right."),
        stepEnded("a2"),
        snap("checks_start", "w1"),
        succeededWith({ status: "not_needed", unverified: true }, "exe_2"),
      ],
      expect: { execution: null, history: ["u1", "a1", "u2", "a2"] },
      rejects: [{ event: checksStarted(1), code: "invalid_transition", why: "no execution is running: checks run under a claim, when a turn that changed files would end" }],
    },
    {
      label: "the next turn changes a file: the checks run on everything unverified, the hand edit included",
      events: [
        enqueue("u3", "Fix add."),
        executionStartedAs("exe_3"),
        snap("delivery", "w1"),
        deliver("u3"),
        ...wrote("a3", SECOND_FIX, "Wrote add.ts", "w1", "w2"),
        stepStarted("a4"),
        say("a4", "Now it adds."),
        stepEnded("a4"),
        snap("checks_start", "w2"),
        checksStarted(1),
        snap("checks_end", "w2"),
        checksFinished(1, "passed", ["add.test.ts", "add.ts"]),
        succeededWith(passed(1, ["add.test.ts", "add.ts"]), "exe_3"),
      ],
      expect: { execution: null, history: ["u1", "a1", "u2", "a2", "u3", "a3", "a4"] },
    },
  ],
}

export const verificationScenarios = [
  checksPass,
  checksFailThenPass,
  checksFailUntilMaxRounds,
  checksAcknowledged,
  noChecksConfigured,
  cancelDuringChecks,
  crashDuringChecks,
  queuedWaitsForTheGate,
  questionAfterHandEdit,
]

/**
 * Compaction: what the loop writes when a conversation outgrows the model's
 * context window. Before every step the loop estimates the size of the
 * request it would send and asks the compaction policy; these scenarios fix
 * what follows from each answer, and what happens when the summary, the
 * user or the process does not cooperate.
 *
 * Sizes are the provider's: each step's usage says how many input tokens its
 * request had. In the scenarios with a context window it is 10,000 tokens,
 * of which the policy keeps 2,000 free for the answer: from 5,200 tokens the
 * next request is "due soon" (compact at the next user message), from 6,400
 * it is compacted before it is sent. The budget for history kept word for
 * word is zero at that size, so a compaction keeps exactly what the next
 * call has to answer: the new input at a user-message boundary, the last
 * step in the middle of a turn.
 */
import {
  NOT_A_SUMMARY,
  NOT_A_SUMMARY_PROBLEMS,
  type Scenario,
  SUMMARY,
  UNUSABLE,
  WINDOW,
  baseline,
  checkpoint,
  compactionEnded,
  compactionFailed,
  compactionRepair,
  compactionStarted,
  deliver,
  enqueue,
  executionInterrupted,
  executionResumed,
  executionStarted,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  opening,
  providerError,
  ran,
  say,
  stepEnded,
  stepEndedAt,
  stepProviderFailed,
  stepStarted,
} from "./script.ts"

/** One step that reads a file, measured at `inputTokens`. Five events. */
const reads = (id: string, path: string, output: string, inputTokens: number) => [
  stepStarted(id),
  ...ran(id, "call_1", "read", JSON.stringify({ path }), output),
  stepEndedAt(id, inputTokens, "tool_calls"),
]
/** One step that answers, measured at `inputTokens`. Three events. */
const answers = (id: string, value: string, inputTokens: number) => [stepStarted(id), say(id, value), stepEndedAt(id, inputTokens)]

// ---------------------------------------------------------------- at a user-message boundary

const dueTurn = [...opening(), ...reads("a1", "a.test.ts", "expect(add(1, 1)).toBe(3)", 4800), ...answers("a2", "The expectation is wrong: 1 + 1 is 2.", 4900), executionSucceeded()]
const dueInput = [enqueue("u2", "Then fix it."), executionStarted("exe_2"), deliver("u2")]

export const atUserBoundary: Scenario = {
  title: "A compaction that is due waits for the next user message",
  description:
    "The first turn grows the request past the early threshold. That is not urgent, so nothing happens between its steps: a compaction in the middle of a turn costs the model the thread of what it was doing. When the user's next message is delivered, the request is still over the threshold, and now is the moment: the loop compacts before it calls the model. The cut is right before the new message, so the checkpoint replaces the first turn and the message stays word for word. `compaction.started` records the cut, the mode and the prompt before the summary request is sent; `compaction.ended` freezes the checkpoint (the summary, the identifier index, the user's earlier messages verbatim). The baseline is set again, and the next request is the checkpoint, the new message and nothing else.",
  provider: "turn 1 is measured at 4,800 and 4,900 input tokens; the summary call returns a summary of the required form; turn 2 answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "first turn: over the early threshold, and nothing is compacted in the middle of it",
      events: dueTurn,
      expect: { history: ["u1", "a1", "a2"], execution: null },
    },
    {
      label: "the next message is delivered: compact before the model is called",
      events: [...dueInput, compactionStarted("c1", 17)],
      expect: { open: "c1", history: ["u1", "a1", "a2", "u2"] },
      rejects: [
        { event: stepStarted("a3"), code: "invalid_transition", why: "the compaction is open: no step starts until it has ended" },
        { event: baseline(), code: "invalid_transition", why: "the baseline is set again only once the compaction has completed" },
      ],
    },
    {
      label: "the checkpoint, the baseline again, and the answer",
      events: [compactionEnded("c1", checkpoint([...dueTurn, ...dueInput], 17)), baseline(), ...answers("a3", "Changed the expectation to 2.", 1200), executionSucceeded("exe_2")],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "u2" }, { id: "c1", kind: "compaction", status: "completed" }, { id: "a3" }],
        history: ["c1", "u2", "a3"],
        execution: null,
      },
    },
  ],
}

// ---------------------------------------------------------------- in the middle of a turn

const longTurn = [
  ...opening("Find out why the build is slow."),
  ...reads("a1", "build.ts", "await bundle(entries)", 3000),
  ...reads("a2", "bundle.ts", "for (const entry of entries) await compile(entry)", 4000),
  ...reads("a3", "compile.ts", "const cache = new Map()", 6000),
]

export const midTurn: Scenario = {
  title: "A compaction in the middle of a long turn",
  description:
    "One turn keeps reading files until the next request would be over the trigger. Waiting for a user message is no longer possible, so the loop compacts between two steps. The cut falls inside the turn: the last step, with its call and its result, is kept word for word, because the next model call answers it; the turn's request and its earlier steps go into the checkpoint, which quotes the request verbatim and ends by telling the model that the work was in progress and to carry on. The model continues the same turn from the checkpoint and the kept step.",
  provider: "the three reading steps are measured at 3,000, 4,000 and 6,000 input tokens; the summary call returns a summary; the model then answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "three steps; after the third the next request is over the trigger",
      events: longTurn,
      expect: { history: ["u1", "a1", "a2", "a3"], open: null },
    },
    {
      label: "compact between two steps, keeping the last one",
      events: [compactionStarted("c1", 16), compactionEnded("c1", checkpoint(longTurn, 16, SUMMARY, true)), baseline()],
      expect: { history: ["c1", "a3"], open: null, execution: { status: "running", crashResumes: 0 } },
      rejects: [
        {
          event: compactionStarted("c2", 15),
          code: "invalid_range",
          why: "the cut only moves forward: a later compaction cannot keep what this one replaced",
        },
      ],
    },
    {
      label: "the turn carries on",
      events: [...answers("a4", "Every entry is compiled one after the other, and the cache is never read.", 1500), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "c1", kind: "compaction", status: "completed" }, { id: "a4" }],
        history: ["c1", "a3", "a4"],
        execution: null,
      },
    },
  ],
}

// ---------------------------------------------------------------- the provider rejects a request

const overflow = providerError("context_overflow", "The input exceeds the context window", 400)
const overflowTurns = [
  ...opening("Explain the architecture."),
  stepStarted("a1"),
  say("a1", "A long explanation."),
  stepEnded("a1"),
  executionSucceeded(),
  enqueue("u2", "Now explain the reducer."),
  executionStarted("exe_2"),
  deliver("u2"),
  stepStarted("a2"),
  stepProviderFailed("a2", overflow),
]

export const contextOverflow: Scenario = {
  title: "The provider rejects a request as too large: compact aggressively and rebuild",
  description:
    "Nobody told the engine the model's context window, so nothing was compacted ahead of time, and in the second turn the provider rejects the request. That is a fact, not an estimate: the loop compacts aggressively (trigger `overflow`) and rebuilds the request (retry rule 5). A compaction can start only at a boundary, so the rejected attempt is first closed as failed, with an empty body, and stays in the log. An aggressive compaction keeps only what fits a small budget, and here nothing does: the new prompt itself goes into the checkpoint, quoted verbatim, with the sentence that the work continues. A second rejection right after this compaction fails the execution.",
  provider: "turn 2, attempt 1 fails with context_overflow before output; the summary call returns a summary; the rebuilt call answers",
  phases: [
    {
      label: "the second turn's request is rejected",
      events: overflowTurns,
      expect: { open: null, history: ["u1", "a1", "u2", "a2"] },
    },
    {
      label: "compact aggressively, then rebuild",
      events: [
        compactionStarted("c1", 13, "overflow", "aggressive"),
        compactionEnded("c1", checkpoint(overflowTurns, 13, SUMMARY, true)),
        baseline(),
        stepStarted("a3"),
        say("a3", "The reducer folds events."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1" },
          { id: "u2" },
          { id: "a2", status: "failed", error: "provider:context_overflow", text: "" },
          { id: "c1", kind: "compaction", status: "completed" },
          { id: "a3" },
        ],
        history: ["c1", "a2", "a3"],
        execution: null,
      },
    },
  ],
}

// ---------------------------------------------------------------- a compaction that frees too little

const heavy = [...opening("Go through the migration scripts."), ...reads("a1", "migrations/0001.sql", "CREATE TABLE ledger (id INTEGER)", 6000)]
const firstCompaction = [compactionStarted("c1", 6), compactionEnded("c1", checkpoint(heavy, 6, SUMMARY, true)), baseline()]
const held = [...reads("a2", "migrations/0002.sql", "ALTER TABLE ledger ADD COLUMN total", 5900), ...reads("a3", "migrations/0003.sql", "CREATE INDEX ledger_total", 7500)]
const beforeSecond = [...heavy, ...firstCompaction, ...held]

export const ineffective: Scenario = {
  title: "A compaction that frees too little: the hold, one aggressive attempt, then nothing more",
  description:
    "The request is over the trigger and the loop compacts, but what must be kept is most of the context: the provider measures the first request after the compaction at almost the size before it. Compacting again at once would summarise a summary, so the policy holds: while the request still fits, the next steps are sent without a compaction, in the headroom between the trigger and the window. When a request would no longer fit at all, there is one aggressive compaction, which keeps nothing word for word. Here that frees too little as well, and nothing more is tried: the request is sent as it is. (Had the provider rejected it, the overflow rule would have ended the execution.) The loop never compacts in a circle.",
  provider:
    "the first step is measured at 6,000 input tokens; the step after the first compaction at 5,900, so it freed too little; the next at 7,500, which with the next result no longer fits; the step after the aggressive compaction again at 7,500; then the model answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "over the trigger: a normal compaction, which keeps the last step",
      events: [...heavy, ...firstCompaction],
      expect: { history: ["c1", "a1"], open: null },
    },
    {
      label: "it freed too little: the next two requests are over the trigger and are sent anyway (the hold)",
      events: held,
      expect: { history: ["c1", "a1", "a2", "a3"], open: null },
    },
    {
      label: "the next request would not fit: one aggressive compaction, which keeps nothing",
      events: [compactionStarted("c2", 24, "auto", "aggressive"), compactionEnded("c2", checkpoint(beforeSecond, 24, SUMMARY, true)), baseline()],
      expect: { history: ["c2"], open: null },
    },
    {
      label: "that freed too little too: the request is sent as it is",
      events: [...reads("a4", "migrations/0004.sql", "DROP INDEX ledger_total", 7500), ...answers("a5", "Four migrations; the last one drops the index the third one made.", 7600), executionSucceeded()],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1" },
          { id: "c1", kind: "compaction", status: "completed" },
          { id: "a2" },
          { id: "a3" },
          { id: "c2", kind: "compaction", status: "completed" },
          { id: "a4" },
          { id: "a5" },
        ],
        history: ["c2", "a4", "a5"],
        execution: null,
      },
    },
  ],
}

// ---------------------------------------------------------------- the summary is not usable

const oneBigStep = [...opening(), ...reads("a1", "a.test.ts", "expect(add(1, 1)).toBe(3)", 6000)]

export const summaryRepaired: Scenario = {
  title: "An invalid summary is repaired",
  description:
    "The model's answer to the summary request does not have the required sections. The loop asks once more: it records the rejected answer and what is wrong with it (`compaction.repair_requested`), and the second request is the first one plus that answer and the request to fix it, so it still reads everything before it from the cache and can be rebuilt from the log. The second answer is valid, and the compaction ends with `source: repaired`.",
  provider: "the first step is measured at 6,000 input tokens; the summary call returns prose without the sections; the repair call returns a summary of the required form; the model then answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "the first answer is not a summary",
      events: [...oneBigStep, compactionStarted("c1", 6)],
      expect: { open: "c1" },
      rejects: [
        {
          event: compactionEnded("c1", "A checkpoint.", "repaired"),
          code: "invalid_transition",
          why: "a compaction ends as repaired only after a repair was asked for",
        },
      ],
    },
    {
      label: "one repair is asked for",
      events: [compactionRepair("c1", NOT_A_SUMMARY, NOT_A_SUMMARY_PROBLEMS)],
      expect: { open: "c1", history: ["u1", "a1"] },
      rejects: [
        {
          event: compactionRepair("c1", NOT_A_SUMMARY, NOT_A_SUMMARY_PROBLEMS, 3),
          code: "invalid_transition",
          why: "a summary is repaired at most once",
        },
      ],
    },
    {
      label: "the repaired summary is used",
      events: [compactionEnded("c1", checkpoint(oneBigStep, 6, SUMMARY, true), "repaired"), baseline(), ...answers("a2", "The expectation is wrong: 1 + 1 is 2.", 1300), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "c1", kind: "compaction", status: "completed" }, { id: "a2" }],
        history: ["c1", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

export const summaryFallback: Scenario = {
  title: "A summary that is still invalid: the checkpoint is built without the model",
  description:
    "The answer to the repair request is not usable either. The loop does not ask a third time and does not give up: it builds the checkpoint without a summary. It says plainly that there is none, and carries what needs no model: the identifier index, the user's messages verbatim, the assistant's last words, and the pointer to the history tools, with which the model can read the original messages. `compaction.ended` says `source: fallback` and why, so a client can tell the user. A compaction therefore always completes, and the session is never lost to a model that cannot summarise.",
  provider: "the first step is measured at 6,000 input tokens; the summary call and the repair call both return prose without the sections; the model then answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "the first answer and the repair are both unusable",
      events: [...oneBigStep, compactionStarted("c1", 6), compactionRepair("c1", NOT_A_SUMMARY, NOT_A_SUMMARY_PROBLEMS)],
      expect: { open: "c1" },
    },
    {
      label: "the compaction completes without a summary",
      events: [
        compactionEnded("c1", checkpoint(oneBigStep, 6, null, true), "fallback", UNUSABLE(NOT_A_SUMMARY_PROBLEMS)),
        baseline(),
        ...answers("a2", "The expectation is wrong: 1 + 1 is 2.", 1300),
        executionSucceeded(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "c1", kind: "compaction", status: "completed" }, { id: "a2" }],
        history: ["c1", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

// ---------------------------------------------------------------- cancel and crash

export const interruptedCompaction: Scenario = {
  title: "Cancel while the summary is being written",
  description:
    "The user cancels while the summary call is streaming. The compaction is closed as interrupted, the marker tells the model that it was stopped, and the claim is released. Nothing about history changed: a compaction that did not complete is only a row in the log. When the user sends the next message the request is as large as before, so the loop compacts again, now at a user-message boundary: the cut cannot fall between the marker and the step it follows, so that step, the marker and the new message are kept.",
  provider: "the first step is measured at 6,000 input tokens; the summary call streams part of a summary and hangs; after the cancel, the second summary call returns a summary and the model answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "the user cancels during the summary call",
      events: [
        ...oneBigStep,
        compactionStarted("c1", 6),
        interruptRequested("user"),
        compactionFailed("c1", { kind: "interrupted", reason: "user" }),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "c1", kind: "compaction", status: "failed", error: "interrupted:user" }, { id: "s1", origin: "interrupt" }],
        history: ["u1", "a1", "s1"],
        execution: null,
        open: null,
      },
    },
    {
      label: "the next message: the compaction is made again",
      events: [
        enqueue("u2", "Go on."),
        executionStarted("exe_2"),
        deliver("u2"),
        compactionStarted("c2", 6),
        compactionEnded(
          "c2",
          checkpoint(oneBigStep, 6),
        ),
        baseline(),
        ...answers("a2", "The expectation is wrong: 1 + 1 is 2.", 1300),
        executionSucceeded("exe_2"),
      ],
      expect: { history: ["c2", "a1", "s1", "u2", "a2"], execution: null },
    },
  ],
}

export const crashedCompaction: Scenario = {
  title: "The process dies during a compaction",
  description:
    "The process dies after `compaction.started` and before the summary arrived. At the next start, recovery closes the compaction as crashed and takes the execution up again (which counts as a crash resume). No step was cut short, so there is no marker. History is what it was, the loop decides again from stored state, finds the request as large as before and compacts again, under a new compaction message.",
  provider: "the first step is measured at 6,000 input tokens; the process dies before the summary call returns; after the restart the summary call returns a summary and the model answers",
  contextWindow: WINDOW,
  phases: [
    {
      label: "the process dies with the compaction open",
      events: [...oneBigStep, compactionStarted("c1", 6)],
      expect: { open: "c1", execution: { status: "running", crashResumes: 0 } },
    },
    {
      label: "at the next start: recovery closes it, and the loop compacts again",
      events: [
        compactionFailed("c1", { kind: "crashed" }),
        executionResumed(),
        compactionStarted("c2", 6),
        compactionEnded("c2", checkpoint(oneBigStep, 6, SUMMARY, true)),
        baseline(),
        ...answers("a2", "The expectation is wrong: 1 + 1 is 2.", 1300),
        executionSucceeded(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "c1", kind: "compaction", status: "failed", error: "crashed" }, { id: "c2", kind: "compaction", status: "completed" }, { id: "a2" }],
        history: ["c2", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

export const compactionScenarios = [
  atUserBoundary,
  midTurn,
  contextOverflow,
  ineffective,
  summaryRepaired,
  summaryFallback,
  interruptedCompaction,
  crashedCompaction,
]

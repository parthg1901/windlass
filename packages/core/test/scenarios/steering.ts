/** Steering and queueing: user input that arrives while the session is working (cancel rule 8). */
import {
  NOT_STARTED,
  type Scenario,
  called,
  deliver,
  enqueue,
  executionInterrupted,
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

export const steerAtNextBoundary: Scenario = {
  title: "A steer arriving mid-step is delivered at the next step boundary",
  description:
    "While a read runs, the user types \"also check b.ts\". The message is admitted to the inbox at once, but it enters history only when the step has ended: after the tool result, as a new user message. Nothing already written is edited, so the next request extends the previous one.",
  provider: "step 1 finishes with one read call; the user steers while it runs; step 2 reads b.ts; step 3 answers",
  phases: [
    {
      label: "the user steers while the read runs",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1"),
        enqueue("u2", "Also check b.ts.", "steer"),
      ],
      expect: { open: "a1", inbox: ["u2"], history: ["u1", "a1"] },
      rejects: [
        {
          event: deliver("u2"),
          code: "invalid_transition",
          why: "input enters history only at a step boundary, never in the middle of a step",
        },
      ],
    },
    {
      label: "the step ends; the steer is delivered before the next step",
      events: [
        settled("a1", "call_1", "success", "export const a = 1"),
        stepEnded("a1", "tool_calls"),
        deliver("u2"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path":"b.ts"}', "export const b = 2"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "a is 1 and b is 2."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", calls: ["call_1 read success"] },
          { id: "u2", kind: "user", text: "Also check b.ts." },
          { id: "a2" },
          { id: "a3" },
        ],
        history: ["u1", "a1", "u2", "a2", "a3"],
        inbox: [],
        execution: null,
      },
    },
  ],
}

export const queueWaitsForIdle: Scenario = {
  title: "A queued message waits until the session would go idle",
  description:
    "While the model works, the user queues a follow-up. Unlike a steer it is not delivered at the next step boundary: the turn runs to its answer first. When the session would otherwise go idle, exactly one queued item is delivered and the loop carries on under the same claim.",
  provider: "step 1 finishes with a read call; step 2 answers with stop; then step 3 answers the queued message",
  phases: [
    {
      label: "the user queues a follow-up",
      events: [
        ...opening(),
        stepStarted("a1"),
        enqueue("u2", "Then write a changelog entry.", "queue"),
        ...ran("a1", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { inbox: ["u2"], open: null },
      gaps: [
        {
          gap: "G11",
          event: deliver("u2"),
          why: "the model still has to answer: a queued item waits until the session would go idle",
        },
      ],
    },
    {
      label: "the turn finishes, still holding the queued item",
      events: [stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2", "stop")],
      expect: { inbox: ["u2"], history: ["u1", "a1", "a2"] },
      gaps: [
        {
          gap: "G6",
          event: executionSucceeded(),
          why: "the execution cannot succeed while input waits; it delivers the queued item instead",
        },
      ],
    },
    {
      label: "the session would go idle: deliver one queued item",
      events: [deliver("u2"), stepStarted("a3"), say("a3", "Added the entry."), stepEnded("a3"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "u2", kind: "user" }, { id: "a3" }],
        history: ["u1", "a1", "a2", "u2", "a3"],
        inbox: [],
        execution: null,
      },
    },
  ],
}

export const steerSurvivesInterrupt: Scenario = {
  title: "A pending steer survives an interrupt",
  description:
    "The user steers while a call is pending and then cancels the turn. The cancel closes the step and releases the claim, but the steer is not withdrawn: it stays in the inbox, visible as waiting, and is the first thing delivered when work starts again. Only `inbox.cancelled` removes it.",
  provider: "step 1 finishes with one read call; the user steers, then cancels before the read starts",
  phases: [
    {
      label: "a steer waits, then the user cancels",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        enqueue("u2", "Use b.ts instead.", "steer"),
        settled("a1", "call_1", "not_started", NOT_STARTED),
        stepInterrupted("a1", "user"),
        interruptMarker("s1", "user"),
        executionInterrupted("user"),
      ],
      expect: { execution: null, open: null, inbox: ["u2"], history: ["u1", "a1", "s1"] },
    },
    {
      label: "work starts again: the steer is delivered first",
      events: [
        executionStarted("exe_2"),
        deliver("u2"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path":"b.ts"}', "export const b = 2"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "b is 2."),
        stepEnded("a3"),
        executionSucceeded("exe_2"),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", calls: ["call_1 read not_started"] },
          { id: "s1", kind: "synthetic" },
          { id: "u2", kind: "user" },
          { id: "a2" },
          { id: "a3" },
        ],
        history: ["u1", "a1", "s1", "u2", "a2", "a3"],
        inbox: [],
        execution: null,
      },
    },
  ],
}

export const steeringScenarios = [steerAtNextBoundary, queueWaitsForIdle, steerSurvivesInterrupt]

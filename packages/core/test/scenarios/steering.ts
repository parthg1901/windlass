/** Steering and queueing: user input that arrives while the session is working (cancel rule 8). */
import {
  type Scenario,
  called,
  deliver,
  enqueue,
  executionInterrupted,
  executionStarted,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  NOT_STARTED,
  opening,
  ran,
  say,
  settled,
  stepEnded,
  stepInterrupted,
  stepStarted,
  toolStarted,
  turnEnded,
  withdrawn,
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
        toolStarted("a1", "call_1", "read"),
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
    "While the model works, the user queues a follow-up. Unlike a steer it is not delivered at the next step boundary: the turn runs to its answer first. When the session would otherwise go idle, the turn ends (`turn.ended`, with what the verification gate found: here nothing is configured, so nothing was verified), exactly one queued item is delivered in the same append, and the loop carries on under the same claim.",
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
      rejects: [
        {
          event: deliver("u2"),
          code: "invalid_transition",
          why: "the model still has to answer: a queued item waits until the session would go idle",
        },
      ],
    },
    {
      label: "the turn finishes, still holding the queued item",
      events: [stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2", "stop")],
      expect: { inbox: ["u2"], history: ["u1", "a1", "a2"] },
      rejects: [
        {
          event: executionSucceeded(),
          code: "invalid_transition",
          why: "the execution cannot succeed while input waits; it delivers the queued item instead",
        },
        {
          event: deliver("u2"),
          code: "invalid_transition",
          why: "whether the turn may end is the gate's decision: turn.ended comes before the delivery of what waited behind the turn",
        },
      ],
    },
    {
      label: "the session would go idle: the turn ends and one queued item is delivered",
      events: [turnEnded(), deliver("u2"), stepStarted("a3"), say("a3", "Added the entry."), stepEnded("a3"), executionSucceeded()],
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
    "The user steers while the model is still responding and then cancels the turn. The cancel closes the step and releases the claim, but the steer is not withdrawn: it stays in the inbox, visible as waiting, and is the first thing delivered when work starts again. Only `inbox.cancelled` removes it.",
  provider: "step 1 streams its first sentence and goes on streaming; the user steers, then cancels",
  phases: [
    {
      label: "a steer waits, then the user cancels",
      events: [
        ...opening(),
        stepStarted("a1"),
        say("a1", "Let me read a.ts."),
        enqueue("u2", "Use b.ts instead.", "steer"),
        interruptRequested("user"),
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
          { id: "a1", status: "failed", calls: [] },
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

export const deliveryOrder: Scenario = {
  title: "Several waiting items: steers first and in order, then one queued item at a time",
  description:
    "While a read runs the user queues two follow-ups and then steers twice. At the step boundary both steers are delivered, oldest first, and the queued items keep waiting. When the turn has its answer, one queued item is delivered and answered before the next. Within a mode the order is the order of admission; a steer never waits behind a queued item.",
  provider: "step 1 finishes with a read call; step 2 answers; steps 3 and 4 answer the two queued items",
  phases: [
    {
      label: "four items are admitted while the read runs",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
        enqueue("q1", "Then update the changelog.", "queue"),
        enqueue("q2", "Then bump the version.", "queue"),
        enqueue("u2", "Also check b.ts.", "steer"),
        enqueue("u3", "And c.ts.", "steer"),
        settled("a1", "call_1", "success", "export const a = 1"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { inbox: ["q1", "q2", "u2", "u3"], open: null },
      rejects: [
        { event: deliver("u3"), code: "invalid_transition", why: "u2 was steered first, so it is delivered first" },
        { event: deliver("q1"), code: "invalid_transition", why: "steered input is delivered before queued input" },
      ],
    },
    {
      label: "both steers are delivered at the boundary, in order",
      events: [deliver("u2"), deliver("u3")],
      expect: { inbox: ["q1", "q2"], history: ["u1", "a1", "u2", "u3"] },
      rejects: [
        { event: deliver("q1"), code: "invalid_transition", why: "the steers are not answered yet, so the session would not go idle" },
        { event: executionSucceeded(), code: "invalid_transition", why: "input was delivered and not answered, and more waits" },
      ],
    },
    {
      label: "the turn gets its answer; one queued item is delivered",
      events: [stepStarted("a2"), say("a2", "a, b and c are fine."), stepEnded("a2"), turnEnded(), deliver("q1")],
      expect: { inbox: ["q2"], history: ["u1", "a1", "u2", "u3", "a2", "q1"] },
      rejects: [
        { event: deliver("q2"), code: "invalid_transition", why: "one queued item at a time: q1 has not been answered" },
      ],
    },
    {
      label: "each queued item is answered before the next is delivered",
      events: [
        stepStarted("a3"),
        say("a3", "Changelog updated."),
        stepEnded("a3"),
        turnEnded(),
        deliver("q2"),
        stepStarted("a4"),
        say("a4", "Version bumped."),
        stepEnded("a4"),
        executionSucceeded(),
      ],
      expect: {
        history: ["u1", "a1", "u2", "u3", "a2", "q1", "a3", "q2", "a4"],
        inbox: [],
        execution: null,
      },
    },
  ],
}

export const withdrawnBeforeDelivery: Scenario = {
  title: "A prompt is withdrawn before it is delivered",
  description:
    "The user steers while a read runs and takes the message back before the step ends (a client that cancels a prompt it just sent). The withdrawal is an event of its own, `inbox.cancelled`: the item leaves the inbox and never becomes a message, so the model never sees it. Nothing else about the turn changes. A prompt that was already delivered cannot be withdrawn; that is what a revert is for.",
  provider: "step 1 finishes with a read call; step 2 answers",
  phases: [
    {
      label: "the user steers while the read runs, then takes it back",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
        enqueue("u2", "Also check b.ts."),
        withdrawn("u2"),
        settled("a1", "call_1", "success", "export const a = 1"),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { inbox: [], open: null, history: ["u1", "a1"] },
      rejects: [
        { event: deliver("u2"), code: "not_found", why: "a withdrawn item is never delivered" },
        { event: withdrawn("u2"), code: "not_found", why: "it is withdrawn once" },
        { event: withdrawn("u1"), code: "not_found", why: "a delivered prompt is history and cannot be withdrawn" },
      ],
    },
    {
      label: "the turn ends without it",
      events: [stepStarted("a2"), say("a2", "a is 1."), stepEnded("a2"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }],
        history: ["u1", "a1", "a2"],
        inbox: [],
        execution: null,
      },
    },
  ],
}

export const steeringScenarios = [steerAtNextBoundary, queueWaitsForIdle, steerSurvivesInterrupt, deliveryOrder, withdrawnBeforeDelivery]

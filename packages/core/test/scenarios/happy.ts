/** Happy paths: nothing goes wrong. */
import {
  type Scenario,
  baseline,
  called,
  created,
  interruptMarker,
  deliver,
  enqueue,
  executionStarted,
  executionSucceeded,
  instruction,
  opening,
  ran,
  say,
  settled,
  stepEnded,
  stepStarted,
  think,
  toolStarted,
} from "./script.ts"

export const plainAnswer: Scenario = {
  title: "A plain answer",
  description:
    "The user asks a question and the model answers in one step without calling a tool. The execution claim is released as soon as the step has ended and nothing waits in the inbox.",
  provider: "streams reasoning, then one text item, then finishes with stop",
  phases: [
    {
      label: "the prompt is admitted and the claim taken",
      events: [created(), enqueue("u1", "What does this repo do?"), executionStarted()],
      gaps: [{ gap: "G10", event: stepStarted("a1"), why: "a step needs the frozen baseline its request is built from" }],
    },
    {
      label: "the baseline is frozen, the prompt delivered, the model answers",
      events: [
        baseline(),
        deliver("u1"),
        stepStarted("a1"),
        think("a1", "Look at the README."),
        say("a1", "It is a coding-agent harness."),
        stepEnded("a1", "stop"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1", kind: "user", text: "What does this repo do?" },
          { id: "a1", kind: "assistant", status: "completed", attempt: 1, text: "It is a coding-agent harness.", calls: [] },
        ],
        history: ["u1", "a1"],
        execution: null,
        open: null,
        inbox: [],
      },
      gaps: [
        {
          gap: "G12",
          event: interruptMarker("s1", "user"),
          why: "history grows only under a running claim, as inbox.delivered already requires",
        },
      ],
    },
  ],
}

export const oneToolCall: Scenario = {
  title: "One tool call, then an answer",
  description:
    "The model reads a file and then answers. The call is durable (tool.called) before the tool starts, the start is durable before the tool runs, and the result is durable before the step ends. The answer is a second step that continues from the reloaded history.",
  provider: "step 1 streams text and one tool call and finishes with tool_calls; step 2 streams text and finishes with stop",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening(),
        stepStarted("a1"),
        say("a1", "Let me read the test."),
        ...ran("a1", "call_1", "read", '{"path":"a.test.ts"}', "expect(add(1, 1)).toBe(3)"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "The expectation is wrong: 1 + 1 is 2."),
        stepEnded("a2", "stop"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "completed", calls: ["call_1 read success"] },
          { id: "a2", status: "completed", text: "The expectation is wrong: 1 + 1 is 2." },
        ],
        history: ["u1", "a1", "a2"],
        execution: null,
        open: null,
      },
    },
  ],
}

export const parallelToolCalls: Scenario = {
  title: "Two parallel tool calls",
  description:
    "The model asks for two reads in one response. Both calls are recorded as they finish streaming, both run at once, and they settle in the order they finish, which need not be the order they were called. The step ends only once both have settled.",
  provider: "step 1 streams two tool calls and finishes with tool_calls; call_2 finishes before call_1; step 2 answers",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        called("a1", "call_2", "read", '{"path":"b.ts"}'),
        toolStarted("a1", "call_1", "read"),
        toolStarted("a1", "call_2", "read"),
        settled("a1", "call_2", "success", "export const b = 2"),
        settled("a1", "call_1", "success", "export const a = 1"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "a is 1 and b is 2."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "completed", calls: ["call_1 read success", "call_2 read success"] },
          { id: "a2", status: "completed" },
        ],
        history: ["u1", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

export const severalSteps: Scenario = {
  title: "Several steps in one turn",
  description:
    "The model reads, edits, runs the tests and answers: four steps under one execution claim. Each step is one model call that starts from the history the previous step left; nothing is carried in memory between them. A provider that reuses call IDs across steps is fine, because calls are keyed by (message, call ID).",
  provider: "three steps that each finish with tool_calls (the provider reuses call_1 every time), then one that finishes with stop",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...ran("a1", "call_1", "read", '{"path":"a.test.ts"}', "expect(add(1, 1)).toBe(3)"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "write", '{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}', "Wrote a.test.ts"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        ...ran("a3", "call_1", "shell", '{"command":"bun test"}', "1 pass, 0 fail"),
        stepEnded("a3", "tool_calls"),
        stepStarted("a4"),
        say("a4", "Fixed the expectation; the test passes."),
        stepEnded("a4"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", calls: ["call_1 read success"] },
          { id: "a2", calls: ["call_1 write success"] },
          { id: "a3", calls: ["call_1 shell success"] },
          { id: "a4", status: "completed", calls: [] },
        ],
        history: ["u1", "a1", "a2", "a3", "a4"],
        execution: null,
      },
    },
  ],
}

export const twoTurns: Scenario = {
  title: "Two turns in one session",
  description:
    "The user asks, gets an answer, and later asks again. Each turn has its own execution claim. Between the turns the date changed, so before the second turn's first step the loop appends the new date as an instruction message (context rule 3) instead of touching the frozen baseline.",
  provider: "each turn: one step that finishes with stop",
  phases: [
    {
      label: "first turn",
      events: [...opening("What is 1 + 1?"), stepStarted("a1"), say("a1", "2"), stepEnded("a1"), executionSucceeded()],
      expect: { history: ["u1", "a1"], execution: null },
    },
    {
      label: "second turn, the next day",
      events: [
        enqueue("u2", "And 2 + 2?"),
        executionStarted("exe_2"),
        instruction("i1", "date", "Today is Friday 13 November 2026."),
        deliver("u2"),
        stepStarted("a2"),
        say("a2", "4"),
        stepEnded("a2"),
        executionSucceeded("exe_2"),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", text: "2" },
          { id: "i1", kind: "instruction", text: "Today is Friday 13 November 2026." },
          { id: "u2", text: "And 2 + 2?" },
          { id: "a2", text: "4" },
        ],
        history: ["u1", "a1", "i1", "u2", "a2"],
        execution: null,
        inbox: [],
      },
    },
  ],
}

export const happyPaths = [plainAnswer, oneToolCall, parallelToolCalls, severalSteps, twoTurns]

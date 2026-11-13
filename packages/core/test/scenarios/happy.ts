/** Happy paths: nothing goes wrong. */
import {
  type Scenario,
  archived,
  unarchived,
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
  settingsChanged,
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
      rejects: [
        { event: stepStarted("a1"), code: "invalid_transition", why: "a step needs the frozen baseline its request is built from" },
      ],
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
      rejects: [
        {
          event: interruptMarker("s1", "user"),
          code: "invalid_transition",
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
    "The model asks for two reads in one response. Each call is recorded and started the moment its arguments finish streaming, before the next one is read, so both run at once while the response is still streaming. They settle in the order they finish, which need not be the order they were called; the request shows the results in call order whatever that order was. The step ends only once both have settled.",
  provider: "step 1 streams two tool calls and finishes with tool_calls; call_2 finishes before call_1; step 2 answers",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
        called("a1", "call_2", "read", '{"path":"b.ts"}'),
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

export const scheduledByConflict: Scenario = {
  title: "Edits of different files run side by side; an edit of the same file and a command wait",
  description:
    "The model asks for two edits, a second edit of the first file and a command in one response. Calls of one response wait only for the earlier calls they conflict with: edits of different files run side by side, an edit of a file waits for an earlier edit of the same file (or of a path inside it, links followed), and a command waits for every edit written before it, because it could change the file an edit was decided about. Each call starts as soon as nothing is in its way, here while the response is still streaming for the first two. The request shows the results in call order whatever order they arrived in.",
  provider: "streams write a.ts, write b.ts, write a.ts again and a shell call; the edit of b.ts finishes first, then the first edit of a.ts; step 2 answers",
  phases: [
    {
      label: "the edits of a.ts and b.ts run side by side; the second edit of a.ts and the command wait",
      events: [
        ...opening("Rename the helper in a.ts and b.ts and run the tests."),
        stepStarted("a1"),
        called("a1", "call_1", "write", '{"path":"a.ts","content":"export const sum = 1"}'),
        toolStarted("a1", "call_1", "write"),
        called("a1", "call_2", "write", '{"path":"b.ts","content":"export const b = sum"}'),
        toolStarted("a1", "call_2", "write"),
        called("a1", "call_3", "write", '{"path":"a.ts","content":"export const sum = 2"}'),
        called("a1", "call_4", "shell", '{"command":"bun test"}'),
      ],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write running", "call_2 write running", "call_3 write pending", "call_4 shell pending"] }] },
    },
    {
      label: "each waiting call starts when what it waits for has its result",
      events: [
        settled("a1", "call_2", "success", "Wrote b.ts"),
        settled("a1", "call_1", "success", "Wrote a.ts"),
        toolStarted("a1", "call_3", "write"),
        settled("a1", "call_3", "success", "Wrote a.ts"),
        toolStarted("a1", "call_4", "shell"),
        settled("a1", "call_4", "success", "3 pass, 0 fail"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "Renamed; the tests pass."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "completed", calls: ["call_1 write success", "call_2 write success", "call_3 write success", "call_4 shell success"] },
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

export const modelSwitch: Scenario = {
  title: "The user switches the model in the middle of a turn",
  description:
    "While the first step's tool runs, the user picks another model. The change is a durable event of its own, written at the step boundary; from then on every step calls the new model, and the request builder takes its parameters from the stored settings. The next request no longer extends the previous one (its first block changed), and the prefix check is told why by this event.",
  provider: "step 1 (gpt-test) finishes with a read call; the user switches to gpt-other; step 2 (gpt-other) answers",
  phases: [
    {
      label: "the first step runs on the session's model",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1", "read"),
      ],
      rejects: [
        {
          event: settingsChanged("gpt-other"),
          code: "invalid_transition",
          why: "the request in flight was built from the old settings: they change only at a step boundary",
        },
      ],
    },
    {
      label: "the step ends and the change is recorded",
      events: [settled("a1", "call_1", "success", "export const a = 1"), stepEnded("a1", "tool_calls"), settingsChanged("gpt-other")],
      rejects: [
        {
          event: stepStarted("a2"),
          code: "invalid_transition",
          why: "a step calls the model the session's settings name, which is gpt-other now",
        },
        { event: settingsChanged("gpt-other"), code: "invalid_transition", why: "an event that changes nothing records no fact" },
      ],
    },
    {
      label: "the turn continues on the new model",
      events: [stepStarted("a2", 1, "gpt-other"), say("a2", "a is 1."), stepEnded("a2"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read success"] }, { id: "a2", status: "completed" }],
        history: ["u1", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

export const AGENTS_IN_API = "agents:/repo/packages/api/AGENTS.md"

export const instructionsInAVisitedDirectory: Scenario = {
  title: "The agent starts working in a directory that has its own instructions",
  description:
    "The session started in `/repo`, whose instructions are in the frozen baseline. The model reads a file in `packages/api`, a directory with an `AGENTS.md` of its own. The loop notes which directories the tool calls of a step touched, and at the next step boundary it looks for instruction files there: the file is appended once, as a message, with its text and fingerprint frozen. The baseline is not rewritten, so the next request is the previous one plus appended items. From then on the file is known, and is appended again only if it changes.",
  provider: "step 1 finishes with a read call in packages/api; step 2 answers",
  phases: [
    {
      label: "the model reads a file in packages/api",
      events: [...opening("What does the handler return?"), stepStarted("a1"), ...ran("a1", "call_1", "read", '{"path":"packages/api/handler.ts"}', "export const handler = () => 200"), stepEnded("a1", "tool_calls")],
      expect: { history: ["u1", "a1"], open: null },
    },
    {
      label: "at the boundary the directory's instructions are appended, then the next step runs",
      events: [instruction("i1", AGENTS_IN_API, "Handlers return status codes, never bodies."), stepStarted("a2"), say("a2", "It returns 200."), stepEnded("a2"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "i1", kind: "instruction" }, { id: "a2" }],
        history: ["u1", "a1", "i1", "a2"],
        execution: null,
      },
      rejects: [{ event: baseline(), code: "invalid_transition", why: "the baseline is frozen until the next compaction: a newly found file is appended, never folded in" }],
    },
  ],
}

export const archiveAndUnarchive: Scenario = {
  title: "A session is archived and brought back",
  description:
    "After a turn the user archives the session (an editor's \"delete\"). Archiving is an event in the session's own log, so it is recorded once and nothing is deleted: the session is only left out of the default listing, and the workspace snapshots that no revert or undo of it could still restore are dropped. Unarchiving is the opposite event, and the session works as before.",
  provider: "answers each of the two prompts with stop",
  phases: [
    {
      label: "a turn, then the session is archived",
      events: [...opening("What is 1 + 1?"), stepStarted("a1"), say("a1", "2"), stepEnded("a1"), executionSucceeded(), archived()],
      expect: { execution: null, archived: true, history: ["u1", "a1"] },
      rejects: [{ event: archived(), code: "invalid_transition", why: "a session is archived once: an event records a change" }],
    },
    {
      label: "it is unarchived and used again",
      events: [unarchived(), enqueue("u2", "And 2 + 2?"), executionStarted("exe_2"), deliver("u2"), stepStarted("a2"), say("a2", "4"), stepEnded("a2"), executionSucceeded("exe_2")],
      expect: { execution: null, archived: false, history: ["u1", "a1", "u2", "a2"] },
      rejects: [{ event: unarchived(), code: "invalid_transition", why: "the session is not archived" }],
    },
  ],
}

export const happyPaths = [plainAnswer, oneToolCall, parallelToolCalls, scheduledByConflict, severalSteps, twoTurns, modelSwitch, instructionsInAVisitedDirectory, archiveAndUnarchive]

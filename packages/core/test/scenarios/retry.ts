/**
 * Retries and the other ways a model call goes wrong without anyone cancelling.
 * One attempt budget per logical step (retry rule 1); see `ATTEMPT_BUDGET`.
 */
import { event } from "../../src/event/durable.ts"
import {
  ATTEMPT_BUDGET,
  STEP_LIMIT,
  type Scenario,
  called,
  continuationNote,
  deliver,
  enqueue,
  executionFailed,
  executionStarted,
  executionSucceeded,
  incompleteStream,
  m,
  opening,
  providerError,
  rateLimited,
  ran,
  retryScheduled,
  say,
  serverError,
  settled,
  stepEnded,
  stepProviderFailed,
  stepStarted,
  synthetic,
} from "./script.ts"

export const retryBeforeOutput: Scenario = {
  title: "A retryable failure before any output",
  description:
    "The first attempt is rate limited before the model wrote anything durable. The retry is transparent: it runs under the same assistant message, nothing failed is left in history, and the message records that it is on attempt 2. The delay is at least the provider's retry-after (retry rule 4).",
  provider: "attempt 1 fails with rate_limit (retry-after 3 s) before any output; attempt 2 streams an answer",
  phases: [
    {
      label: "attempt 1 is rate limited",
      events: [...opening(), stepStarted("a1"), retryScheduled("a1", 2, rateLimited, 3000)],
      expect: { open: "a1", ui: [{ id: "u1" }, { id: "a1", status: "running", attempt: 2, text: "" }] },
    },
    {
      label: "attempt 2 succeeds under the same message",
      events: [say("a1", "Here is the fix."), stepEnded("a1"), executionSucceeded()],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "completed", attempt: 2, text: "Here is the fix.", error: null }],
        history: ["u1", "a1"],
        execution: null,
      },
    },
  ],
}

export const retryAfterPartialText: Scenario = {
  title: "A retryable failure after partial text: the model is asked to continue",
  description:
    "The server fails after the model had written part of its answer, which the user saw. That text is now durable output, so the retry cannot be transparent: the message is marked failed with its partial text kept, and the next attempt runs under a new message with attempt 2. Between the two the loop appends a short harness note asking the model to continue from where it stopped. Without the note the next request ends on the model's own half sentence and the model starts its answer again from the top (checked against the live provider); with it, the new message picks up mid-sentence. Both messages stay in the UI, and the model sees the partial message, the note and the continuation.",
  provider: "attempt 1 streams \"Let me look at the\" and then fails with provider_internal (HTTP 500); attempt 2 continues the sentence",
  phases: [
    {
      label: "attempt 1 fails after output",
      events: [...opening(), stepStarted("a1"), say("a1", "Let me look at the")],
      rejects: [
        {
          event: retryScheduled("a1", 2, serverError),
          code: "invalid_transition",
          why: "after durable output the retry may not continue under the same message",
        },
        {
          event: continuationNote("s1"),
          code: "invalid_transition",
          why: "a message enters history only at a step boundary: the failed step is closed first",
        },
      ],
    },
    {
      label: "the message fails and a retry is scheduled",
      events: [stepProviderFailed("a1", serverError), retryScheduled("a1", 2, serverError)],
      rejects: [
        {
          event: stepStarted("a2", 1),
          code: "invalid_transition",
          why: "the retry continues the step's attempt budget, so it must carry the scheduled attempt 2",
        },
        {
          event: retryScheduled("a1", 3, serverError),
          code: "invalid_transition",
          why: "attempt 2 is already scheduled; the budget moves on when the new message starts",
        },
        {
          event: executionSucceeded(),
          code: "invalid_transition",
          why: "the latest step failed, so the model has not answered",
        },
      ],
    },
    {
      label: "the model is asked to continue, and the retry runs under a new message",
      events: [continuationNote("s1"), stepStarted("a2", 2)],
      expect: {
        open: "a2",
        history: ["u1", "a1", "s1", "a2"],
        ui: [{ id: "u1" }, { id: "a1", status: "failed" }, { id: "s1", kind: "synthetic", origin: "continuation" }, { id: "a2", status: "running", attempt: 2 }],
      },
      rejects: [
        {
          event: retryScheduled("a1", 3, serverError),
          code: "invalid_transition",
          why: "a1 is no longer the step in progress; only a2 can be retried now",
        },
      ],
    },
    {
      label: "the continuation",
      events: [say("a2", " test first, then the implementation."), stepEnded("a2"), executionSucceeded()],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", attempt: 1, error: "provider:provider_internal", text: "Let me look at the" },
          { id: "s1", kind: "synthetic", origin: "continuation" },
          { id: "a2", status: "completed", attempt: 2, text: " test first, then the implementation." },
        ],
        history: ["u1", "a1", "s1", "a2"],
        execution: null,
      },
    },
  ],
}

export const streamWithoutTerminal: Scenario = {
  title: "A stream that ends with no terminal event",
  description:
    "The connection closes cleanly in the middle of the response: no `finish`, no `error`, and the abort signal did not fire. The loop treats it as `incomplete_stream`, which is retryable. Here nothing durable had been written, so it is the transparent retry.",
  provider: "attempt 1 yields one reasoning delta and then the iterator ends; attempt 2 answers",
  phases: [
    {
      label: "the stream just stops",
      events: [
        ...opening(),
        stepStarted("a1"),
        retryScheduled("a1", 2, incompleteStream, 2000),
        say("a1", "Done."),
        stepEnded("a1"),
        executionSucceeded(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "completed", attempt: 2 }],
        history: ["u1", "a1"],
        execution: null,
      },
    },
  ],
}

export const budgetExhausted: Scenario = {
  title: "The attempt budget runs out",
  description: `Every attempt fails before output. After attempt ${ATTEMPT_BUDGET}, the last of the budget, no retry is scheduled: the step fails with the last error and the execution fails, releasing the claim. One failed message is left, with an empty body; the user can prompt again.`,
  provider: `attempts 1 to ${ATTEMPT_BUDGET} each fail with provider_internal before any output`,
  phases: [
    {
      label: "every attempt fails",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...Array.from({ length: ATTEMPT_BUDGET - 1 }, (_, index) => retryScheduled("a1", index + 2, serverError, 2000 * 2 ** index)),
        stepProviderFailed("a1", serverError),
        executionFailed(`The model call failed ${ATTEMPT_BUDGET} times: The server had an error`),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "failed", attempt: ATTEMPT_BUDGET, error: "provider:provider_internal", text: "" }],
        history: ["u1", "a1"],
        execution: null,
        open: null,
      },
    },
  ],
}

const nonRetryable = (
  kind: "auth" | "usage_limit" | "invalid_request",
  title: string,
  why: string,
  message: string,
  status: number,
): Scenario => {
  const error = providerError(kind, message, status)
  return {
    title,
    description: `${why} Retrying it unchanged cannot work (retry rule 3), so there is no retry.scheduled: the step fails with the classified error and the execution fails with a message the UI can act on.`,
    provider: `attempt 1 fails with ${kind} (HTTP ${status}) before any output`,
    phases: [
      {
        label: "the call is rejected",
        events: [...opening(), stepStarted("a1"), stepProviderFailed("a1", error)],
        rejects: [
          { event: retryScheduled("a1", 2, error), code: "invalid_transition", why: `${kind} is not retryable` },
        ],
      },
      {
        label: "the execution fails",
        events: [executionFailed(message)],
        expect: {
          ui: [{ id: "u1" }, { id: "a1", status: "failed", error: `provider:${kind}` }],
          history: ["u1", "a1"],
          execution: null,
        },
      },
    ],
  }
}

export const authFailure = nonRetryable(
  "auth",
  "A non-retryable error: authentication",
  "The ChatGPT sign-in expired.",
  "Signed out: sign in again to continue.",
  401,
)
export const usageLimit = nonRetryable(
  "usage_limit",
  "A non-retryable error: usage limit",
  "The plan's usage limit is exhausted until it resets.",
  "Usage limit reached; it resets in 3 hours.",
  429,
)
export const invalidRequest = nonRetryable(
  "invalid_request",
  "A non-retryable error: invalid request",
  "The provider rejected the request as malformed.",
  "The provider rejected the request: Invalid 'input[3].call_id'.",
  400,
)

export const malformedArguments: Scenario = {
  title: "Malformed tool arguments",
  description:
    "The model writes arguments that are not valid JSON. The call is recorded exactly as written, never started, and settled as `error` with a message telling the model what was wrong (retry rule 6). The step ends normally and the model calls again with valid arguments.",
  provider: "step 1 finishes with a read call whose arguments are `{\"path\": \"a.ts\"` (no closing brace); step 2 calls it correctly; step 3 answers",
  phases: [
    {
      label: "the arguments do not parse",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path": "a.ts"'),
        settled(
          "a1",
          "call_1",
          "error",
          "The arguments are not valid JSON (unexpected end of input at position 15). Call read again with a JSON object.",
        ),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: ["call_1 read error"] }] },
    },
    {
      label: "the model tries again",
      events: [
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path": "a.ts"}', "export const a = 1"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "a is 1."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 read error"] }, { id: "a2", calls: ["call_1 read success"] }, { id: "a3" }],
        history: ["u1", "a1", "a2", "a3"],
        execution: null,
      },
    },
  ],
}

export const argumentsCutOff: Scenario = {
  title: "Tool arguments cut off by the output limit",
  description:
    "The model hits its output limit while writing a large file's content. The call never finished streaming, so it is never recorded and never executed (retry rule 6). The step ends with finish `length`, and the loop appends a note telling the model why nothing ran, then continues.",
  provider: "step 1 streams text and the arguments of a write call, then finishes with length before the call ends; step 2 writes a shorter file; step 3 answers",
  phases: [
    {
      label: "the response hits the output limit",
      events: [...opening(), stepStarted("a1"), say("a1", "I'll write the new module."), stepEnded("a1", "length")],
      expect: { ui: [{ id: "u1" }, { id: "a1", status: "completed", calls: [] }] },
    },
    {
      label: "the model is told and tries again",
      events: [
        synthetic(
          "s1",
          "output_limit",
          "Your last response reached the output limit while writing a tool call, so the call was not run. Split the work into smaller calls.",
        ),
        stepStarted("a2"),
        ...ran("a2", "call_1", "write", '{"path":"m.ts","content":"export {}"}', "Wrote m.ts"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
        say("a3", "Created m.ts."),
        stepEnded("a3"),
        executionSucceeded(),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1" }, { id: "s1", kind: "synthetic", origin: "output_limit" }, { id: "a2" }, { id: "a3" }],
        history: ["u1", "a1", "s1", "a2", "a3"],
        execution: null,
      },
    },
  ],
}

export const emptyResponse: Scenario = {
  title: "An empty response: one nudge, then failure",
  description:
    "The model finishes with no text, no reasoning and no tool call. The loop appends one nudge and asks again (retry rule 8). The second response is empty too, so the execution fails instead of nudging again.",
  provider: "steps 1 and 2 each finish with stop and no output items",
  phases: [
    {
      label: "the first empty response is nudged",
      events: [
        ...opening(),
        stepStarted("a1"),
        stepEnded("a1", "stop"),
        synthetic("s1", "empty_response", "Your last response was empty. Continue with the task, or say that you are done."),
      ],
      expect: { history: ["u1", "a1", "s1"] },
    },
    {
      label: "the second one fails the execution",
      events: [stepStarted("a2"), stepEnded("a2", "stop"), executionFailed("The model returned an empty response twice.")],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "completed", text: "", calls: [] },
          { id: "s1", origin: "empty_response" },
          { id: "a2", status: "completed", text: "", calls: [] },
        ],
        history: ["u1", "a1", "s1", "a2"],
        execution: null,
      },
    },
  ],
}

export const identicalCallGuard: Scenario = {
  title: "The same call with the same arguments, again and again",
  description:
    "The model reads the same file with the same arguments in three consecutive steps and gets the same result. The third identical call trips the guard (retry rule 9): it is refused before running, settled as `error` with a message, and the model moves on.",
  provider: "steps 1 to 3 each call read with `{\"path\":\"a.ts\"}`; step 4 answers",
  phases: [
    {
      label: "two identical calls run",
      events: [
        ...opening(),
        stepStarted("a1"),
        ...ran("a1", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path":"a.ts"}', "export const a = 1"),
        stepEnded("a2", "tool_calls"),
      ],
    },
    {
      label: "the third is refused without running",
      events: [
        stepStarted("a3"),
        called("a3", "call_1", "read", '{"path":"a.ts"}'),
        settled(
          "a3",
          "call_1",
          "error",
          "Not run: this exact call already ran twice in this turn with the same result. Use that result or try something else.",
        ),
        stepEnded("a3", "tool_calls"),
        stepStarted("a4"),
        say("a4", "a is 1."),
        stepEnded("a4"),
        executionSucceeded(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", calls: ["call_1 read success"] },
          { id: "a2", calls: ["call_1 read success"] },
          { id: "a3", calls: ["call_1 read error"] },
          { id: "a4" },
        ],
        history: ["u1", "a1", "a2", "a3", "a4"],
        execution: null,
      },
    },
  ],
}

export const stepLimit: Scenario = {
  title: "The step limit is reached",
  description: `After ${STEP_LIMIT} steps that each asked for tools, the loop appends a note that tools are now disabled and makes one final call with tool choice \`none\`. Tool choice is not part of the cached prefix and is not stored, so only the note is durable. The final answer ends the turn.`,
  provider: `steps 1 to ${STEP_LIMIT} each finish with a read call; the final call (tool choice none) answers with stop`,
  phases: [
    {
      label: "the limit is reached",
      events: [
        ...opening(),
        ...Array.from({ length: STEP_LIMIT }, (_, index) => [
          stepStarted(`a${index + 1}`),
          ...ran(`a${index + 1}`, "call_1", "read", `{"path":"f${index + 1}.ts"}`, `file ${index + 1}`),
          stepEnded(`a${index + 1}`, "tool_calls"),
        ]).flat(),
      ],
    },
    {
      label: "one final call with tools forbidden",
      events: [
        synthetic(
          "s1",
          "step_limit",
          "You have reached the step limit for this turn, so tools are disabled. Summarise what you did and what is left.",
        ),
        stepStarted(`a${STEP_LIMIT + 1}`),
        say(`a${STEP_LIMIT + 1}`, "I read three files; the fix is still to do."),
        stepEnded(`a${STEP_LIMIT + 1}`, "stop"),
        executionSucceeded(),
      ],
      expect: {
        history: ["u1", "a1", "a2", "a3", "s1", "a4"],
        ui: [{ id: "u1" }, { id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "s1", origin: "step_limit" }, { id: "a4", calls: [] }],
        execution: null,
      },
    },
  ],
}

const overflow = providerError("context_overflow", "The input exceeds the context window", 400)

export const contextOverflow: Scenario = {
  title: "Context overflow before any output: compact once and rebuild",
  description:
    "In the second turn the request no longer fits. No output had started, so the loop compacts once and rebuilds the request (retry rule 5). A compaction can start only at a boundary, so the overflowed attempt is first closed as failed, with an empty body, and stays in model history (gap G13). The checkpoint keeps the new prompt verbatim. A second overflow after this compaction would fail the execution.",
  provider: "turn 2, attempt 1 fails with context_overflow before output; the compaction call returns a summary; the rebuilt call answers",
  phases: [
    {
      label: "first turn",
      events: [...opening("Explain the architecture."), stepStarted("a1"), say("a1", "A long explanation."), stepEnded("a1"), executionSucceeded()],
    },
    {
      label: "second turn overflows",
      events: [
        enqueue("u2", "Now explain the reducer."),
        executionStarted("exe_2"),
        deliver("u2"),
        stepStarted("a2"),
        stepProviderFailed("a2", overflow),
      ],
      expect: { open: null },
    },
    {
      label: "compact once, then rebuild",
      events: [
        event("compaction.started", { messageId: m("c1"), trigger: "overflow" }),
        event("compaction.ended", { messageId: m("c1"), summary: "The user asked about the architecture; it was explained.", keepFromSeq: 12, usage: null }),
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
        history: ["c1", "u2", "a2", "a3"],
        execution: null,
      },
    },
  ],
}

export const retryScenarios = [
  retryBeforeOutput,
  retryAfterPartialText,
  streamWithoutTerminal,
  budgetExhausted,
  authFailure,
  usageLimit,
  invalidRequest,
  malformedArguments,
  argumentsCutOff,
  emptyResponse,
  identicalCallGuard,
  stepLimit,
  contextOverflow,
]

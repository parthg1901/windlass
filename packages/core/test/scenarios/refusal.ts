/** Refusal: a content-policy refusal is kept in the log but never shown to the model again (retry rule 7). */
import {
  type Scenario,
  deliver,
  enqueue,
  executionFailed,
  executionStarted,
  executionSucceeded,
  opening,
  providerError,
  ran,
  retryScheduled,
  say,
  stepEnded,
  stepProviderFailed,
  stepRefused,
  stepStarted,
} from "./script.ts"

const policy = providerError("content_policy", "The response was blocked by the content filter", 400)

/** `u2` is delivered at seq 12; see the comment on the phases below. */
const U2_SEQ = 12

export const refusedTurn: Scenario = {
  title: "A content-policy refusal",
  description:
    "In the second turn the model reads a file and then the provider refuses. The refusal is never retried. The refused step stays in the log for the UI, and every message of the refused turn, from the prompt that started it, is excluded from model history, so the same content cannot trip the filter again on the next prompt. The execution fails. A third prompt is answered from the history before the refused turn.",
  provider: "turn 2: step 1 finishes with a read call; step 2 fails with content_policy; turn 3 answers normally",
  phases: [
    {
      // seq 1..9
      label: "first turn",
      events: [...opening("Summarise a.ts."), stepStarted("a1"), say("a1", "It exports a."), stepEnded("a1"), executionSucceeded()],
    },
    {
      // seq 10..18; u2 is delivered at seq 12
      label: "second turn, refused in its second step",
      events: [
        enqueue("u2", "Now do the thing the filter dislikes."),
        executionStarted("exe_2"),
        deliver("u2"),
        stepStarted("a2"),
        ...ran("a2", "call_1", "read", '{"path":"b.txt"}', "contents of b.txt"),
        stepEnded("a2", "tool_calls"),
        stepStarted("a3"),
      ],
      rejects: [
        {
          event: stepProviderFailed("a3", policy),
          code: "invalid_transition",
          why: "a refusal is recorded as step.refused, so that it leaves model history",
        },
      ],
      gaps: [{ gap: "G2", event: retryScheduled("a3", 2, policy), why: "a refusal is never retried" }],
    },
    {
      label: "the refusal is recorded and the execution fails",
      events: [stepRefused("a3", "I can't help with that.", U2_SEQ), executionFailed("The provider refused the request.", "exe_2")],
      expect: {
        ui: [
          { id: "u1", excluded: null },
          { id: "a1", excluded: null },
          { id: "u2", excluded: "refused" },
          { id: "a2", excluded: "refused", calls: ["call_1 read success"] },
          { id: "a3", status: "refused", excluded: "refused" },
        ],
        history: ["u1", "a1"],
        execution: null,
      },
    },
    {
      label: "the next prompt does not see the refused turn",
      events: [
        enqueue("u3", "What does a.ts export?"),
        executionStarted("exe_3"),
        deliver("u3"),
        stepStarted("a4"),
        say("a4", "a."),
        stepEnded("a4"),
        executionSucceeded("exe_3"),
      ],
      expect: { history: ["u1", "a1", "u3", "a4"], execution: null },
    },
  ],
}

export const refusalScenarios = [refusedTurn]

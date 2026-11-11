/**
 * A minimal startup recovery for tests: settle every claimed session the way
 * the step loop's recovery will, in one append per session. It exists so the
 * crash test can keep appending to sessions a killed writer left open.
 *
 * It follows the reducer's rules for what recovery may write:
 * - orphaned calls settle from the effect class their start recorded;
 * - with an interrupt requested, the open step or compaction closes as
 *   interrupted for that reason and the execution ends interrupted;
 * - otherwise the open step closes as crashed;
 * - a step that was cut short is followed by the interrupt marker.
 * Unlike the real recovery it never resumes: every session ends idle.
 */
import { type NewEvent, type StepError, HARNESS_ORIGIN, event } from "../../src/event/durable.ts"
import { text } from "../../src/content.ts"
import type { MessageId } from "../../src/id.ts"
import { type ToolCallState, hasSideEffect } from "../../src/message/message.ts"
import type { Store } from "../../src/store/store.ts"

/** How an orphaned call settles, from the effect class its start recorded and nothing else. */
function orphanOutcome(state: Exclude<ToolCallState, { status: "settled" }>) {
  if (state.status === "pending")
    return { outcome: "not_started", output: "Not run: the harness stopped before this call started." } as const
  if (!hasSideEffect(state.effect))
    return { outcome: "error", output: "The harness stopped while this call was running. Nothing was changed." } as const
  return { outcome: "effect_unknown", output: "The harness stopped while this call was running; its effect is unknown." } as const
}

export function recoverClaimedSessions(store: Store): number {
  const claimed = store.listClaimedSessions()
  for (const summary of claimed) {
    const projection = store.getProjection(summary.session.id)!
    const execution = projection.session.execution!
    const events: NewEvent[] = []
    const error: StepError =
      execution.interrupting === null ? { kind: "crashed" } : { kind: "interrupted", reason: execution.interrupting }
    const open = projection.session.open
    const last = projection.messages.at(-1)
    // The writer may have died between a cut-short step and its marker.
    let owesMarker =
      last?.kind === "assistant" &&
      last.seq > execution.startedSeq &&
      last.status === "failed" &&
      (last.error?.kind === "interrupted" || last.error?.kind === "crashed")
    if (open?.kind === "step") {
      const message = projection.messages.findLast((candidate) => candidate.id === open.messageId)
      if (message?.kind !== "assistant") throw new Error(`open step ${open.messageId} has no assistant message`)
      for (const part of message.parts)
        if (part.type === "tool_call" && part.state.status !== "settled")
          events.push(
            event("tool.settled", {
              messageId: message.id,
              callId: part.callId,
              ...orphanOutcome(part.state),
              truncation: null,
              attachments: [],
              display: null,
            }),
          )
      events.push(event("step.failed", { messageId: message.id, error, usage: null }))
      owesMarker = true
    }
    if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error }))
    if (owesMarker)
      events.push(
        event("synthetic.appended", {
          messageId: `recovery_marker_${summary.lastSeq}` as MessageId,
          origin: HARNESS_ORIGIN.interrupt,
          content: text("The previous response was cut short when the harness restarted."),
        }),
      )
    if (execution.interrupting !== null)
      events.push(event("execution.interrupted", { executionId: execution.id, reason: execution.interrupting }))
    // A user interrupt released the claim; everything else is given up here instead of resumed.
    if (execution.interrupting !== "user")
      events.push(event("execution.failed", { executionId: execution.id, message: "the process died" }))
    store.append(summary.session.id, events, { expectedSeq: summary.lastSeq })
  }
  return claimed.length
}

/**
 * A minimal startup recovery for tests: settle every claimed session the way
 * the step loop's recovery will, in one append per session. It exists so the
 * crash test can keep appending to sessions a killed writer left open.
 */
import { type NewEvent, event } from "../../src/event/durable.ts"
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
    const events: NewEvent[] = []
    const open = projection.session.open
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
      events.push(event("step.failed", { messageId: message.id, error: { kind: "crashed" }, usage: null }))
    }
    if (open?.kind === "compaction")
      events.push(event("compaction.failed", { messageId: open.messageId, error: { kind: "crashed" } }))
    events.push(event("execution.failed", { executionId: summary.session.execution!.id, message: "the process died" }))
    store.append(summary.session.id, events, { expectedSeq: summary.lastSeq })
  }
  return claimed.length
}

/**
 * A startup recovery for tests: repair every claimed session with the step
 * loop's own recovery (`recover` in `src/engine/recovery.ts`), in one append
 * per session. It exists so the crash test can keep appending to sessions a
 * killed writer left open.
 *
 * Unlike the engine it never resumes: the resume cap is zero, so a crashed
 * claim ends as failed, and a claim a shutdown suspended is given up in the
 * same append. Every session ends idle.
 */
import { event } from "../../src/event/durable.ts"
import { recover } from "../../src/engine/recovery.ts"
import type { MessageId } from "../../src/id.ts"
import type { Store } from "../../src/store/store.ts"

export function recoverClaimedSessions(store: Store): number {
  const claimed = store.listClaimedSessions()
  for (const summary of claimed) {
    const projection = store.getProjection(summary.session.id)!
    let next = 0
    const recovery = recover(projection, {
      crashResumeCap: 0,
      newMessageId: () => `recovery_${summary.lastSeq}_${next++}` as MessageId,
    })
    const events = [...recovery.events]
    if (recovery.claim === "suspended")
      events.push(event("execution.failed", { executionId: projection.session.execution!.id, message: "the process died" }))
    store.append(summary.session.id, events, { expectedSeq: summary.lastSeq })
  }
  return claimed.length
}

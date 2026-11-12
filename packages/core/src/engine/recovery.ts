/**
 * Recovery of a session that still holds an execution claim when it is
 * opened: the procedure of `docs/step-loop-scenarios.md`, "Recovery at
 * start-up", as one pure function from the projection to the events to append.
 *
 * 1. An interrupt was requested. Finish it: settle every unsettled call,
 *    close the open step or compaction as interrupted for that reason, write
 *    the marker, write `execution.interrupted`. A user cancel leaves the
 *    session idle; a shutdown leaves the claim suspended. (An execution with
 *    no turn, `turnless`, gets no marker: nothing of the model's was cut.)
 * 2. The claim is `running` and nothing was requested. The process died.
 *    Settle, close the open step as crashed, write the marker, then
 *    `execution.resumed` (which counts the crash), or `execution.failed` once
 *    the cap is reached. An open run of checks is closed as crashed too.
 *    Recovery never writes `execution.succeeded`: even with nothing open and
 *    nothing left to answer, ending as done is the verification gate's
 *    decision, so the execution is resumed and the loop makes it.
 * 3. The claim is `suspended`. Nothing to repair; whoever resumes it writes
 *    `execution.resumed`, which is not counted.
 *
 * Orphaned calls settle from the state and effect class the log recorded,
 * never from the tool registry of the build that restarts.
 */
import { type NewEvent, type StepError, HARNESS_ORIGIN, event } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import type { Projection } from "../message/message.ts"
import { FAILURE_TEXT, NOTE_TEXT } from "./constants.ts"
import { CRASHED, note, openStep, owesMarker, settleUnsettled, turnless } from "./state.ts"

export interface Recovery {
  /** What to append, in one transaction. Empty when there is nothing to repair. */
  readonly events: readonly NewEvent[]
  /** The claim once `events` are appended. */
  readonly claim: "none" | "running" | "suspended"
}

export function recover(
  projection: Projection,
  options: { readonly crashResumeCap: number; readonly newMessageId: () => MessageId },
): Recovery {
  const execution = projection.session.execution
  if (execution === null) return { events: [], claim: "none" }
  if (execution.status === "suspended") return { events: [], claim: "suspended" }

  const reason = execution.interrupting
  const error: StepError = reason === null ? { kind: "crashed" } : { kind: "interrupted", reason }
  const events: NewEvent[] = []
  // The process may have died between closing a cut-short step and writing its marker.
  let cutShort = owesMarker(projection)
  const step = openStep(projection)
  if (step !== null) {
    events.push(...settleUnsettled(step, CRASHED), event("step.failed", { messageId: step.id, error, usage: null }))
    cutShort = true
  }
  const open = projection.session.open
  if (open?.kind === "compaction") events.push(event("compaction.failed", { messageId: open.messageId, error }))
  // A run of checks the process died in produced nothing: the gate runs them again when the execution is taken up.
  if (open?.kind === "checks") events.push(event("checks.failed", { run: open.run, error }))
  const marker = (text: string) => note(options.newMessageId(), HARNESS_ORIGIN.interrupt, text)

  if (reason !== null) {
    const last = projection.messages.at(-1)
    const marked = last?.kind === "synthetic" && last.origin === HARNESS_ORIGIN.interrupt && last.seq > execution.startedSeq
    // A user cancel is always told to the model, unless the execution had no turn to cancel (a compaction the user
    // asked for and nothing else); a shutdown only when it cut a step short.
    if (reason === "user" ? cutShort || (!marked && !turnless(projection)) : cutShort)
      events.push(marker(reason === "user" ? NOTE_TEXT.interruptedByUser : NOTE_TEXT.interruptedByRestart))
    events.push(event("execution.interrupted", { executionId: execution.id, reason }))
    return { events, claim: reason === "user" ? "none" : "suspended" }
  }

  if (cutShort) events.push(marker(NOTE_TEXT.interruptedByRestart))
  if (execution.crashResumes >= options.crashResumeCap) {
    events.push(event("execution.failed", { executionId: execution.id, message: FAILURE_TEXT.crashCap(options.crashResumeCap) }))
    return { events, claim: "none" }
  }
  // Also when the answer was durable and nothing waits: whether the execution may end as done is the gate's
  // decision, which needs the configuration and may have to run checks. Recovery never ends an execution as done.
  events.push(event("execution.resumed", { executionId: execution.id }))
  return { events, claim: "running" }
}

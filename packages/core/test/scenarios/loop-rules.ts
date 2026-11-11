/**
 * Ordering rules the step loop must follow that the reducer does not enforce
 * today. Each rule names the gap in docs/step-loop-scenarios.md that proposes
 * moving it into the reducer. Until then this checker is how a loop test can
 * assert them: fold the events the loop wrote and expect no violations.
 */
import type { NewEvent } from "../../src/event/durable.ts"
import type { AssistantMessage, Projection } from "../../src/message/message.ts"
import { TOOLS, type ToolName, fold } from "./script.ts"

export function loopViolations(events: readonly NewEvent[]): string[] {
  const violations: string[] = []
  let state: Projection | null = null
  /** Set by `step.failed` with `interrupted`: the reason the execution must now end with. */
  let interrupting: string | null = null
  /** Set by `retry.scheduled` on a failed message: the attempt the next step must carry. */
  let pendingAttempt: number | null = null
  let previous: NewEvent | null = null

  for (const [index, item] of events.entries()) {
    const at = `event ${index + 1} (${item.type})`
    const flag = (gap: string, rule: string) => violations.push(`${at}: ${gap} ${rule}`)

    if (previous?.type === "step.failed" && ["interrupted", "crashed"].includes(previous.data.error.kind))
      if (item.type !== "synthetic.appended" || item.data.origin !== "interrupt")
        flag("rule", "an interrupted or crashed step is followed at once by the interrupt marker")

    if (state !== null) {
      const latest = latestAssistant(state)
      switch (item.type) {
        case "step.started": {
          if (state.baseline === null) flag("G10", "a step needs a frozen baseline")
          if (interrupting !== null) flag("G5", "no step may start after an interrupted step")
          const expected = pendingAttempt ?? 1
          if (item.data.attempt !== expected) flag("G4", `this step must carry attempt ${expected}`)
          pendingAttempt = null
          break
        }
        case "retry.scheduled": {
          if (!item.data.error.retryable) flag("G2", `${item.data.error.kind} is not retryable`)
          if (latest?.id !== item.data.messageId) flag("G3", "only the latest step can be retried")
          if (latest?.status === "running" && latest.parts.length > 0)
            flag("G1", "after durable output the message fails and the retry runs under a new one")
          if (latest?.status === "failed" && latest.error?.kind !== "provider")
            flag("G2", "only a provider failure is retried")
          if (state.session.open !== null && state.session.open.messageId !== item.data.messageId)
            flag("G3", "a retry cannot be scheduled while another step is open")
          pendingAttempt = latest?.status === "failed" ? item.data.attempt : null
          break
        }
        case "execution.succeeded":
          if (state.inbox.length > 0) flag("G6", "the execution cannot succeed while input waits in the inbox")
          if (interrupting !== null) flag("G5", "an interrupted execution ends as interrupted")
          if (latest === undefined || latest.seq < (state.session.execution?.startedSeq ?? 0) || latest.status !== "completed" || latest.finish === "tool_calls")
            flag("G6", "the execution succeeds only after a completed step that did not ask for tools")
          break
        case "execution.interrupted":
          if (interrupting !== null && interrupting !== item.data.reason)
            flag("G5", `the step was interrupted for ${interrupting}, so the execution is too`)
          break
        case "execution.failed":
          if (interrupting !== null) flag("G5", "an interrupted execution ends as interrupted")
          break
        case "inbox.delivered": {
          const waiting = state.inbox.find((candidate) => candidate.messageId === item.data.messageId)
          const steerWaits = state.inbox.some((candidate) => candidate.delivery === "steer")
          if (waiting?.delivery === "queue") {
            if (steerWaits) flag("G11", "steered input is delivered before queued input")
            const sinceClaim = latest !== undefined && latest.seq > (state.session.execution?.startedSeq ?? Infinity)
            if (sinceClaim && latest.finish !== "stop") flag("G11", "queued input waits until the session would go idle")
          }
          break
        }
        case "tool.settled": {
          const part = latest?.parts.find((candidate) => candidate.type === "tool_call" && candidate.callId === item.data.callId)
          const name = part?.type === "tool_call" ? part.name : ""
          if (item.data.outcome === "effect_unknown" && TOOLS[name as ToolName] === "read")
            flag("G8", "a read-only call has no unknown effect; it settles as error")
          break
        }
        case "synthetic.appended":
        case "instruction.appended":
          if (state.session.execution?.status !== "running") flag("G12", "history grows only under a running claim")
          break
      }
    }

    if (item.type === "step.failed" && item.data.error.kind === "interrupted") interrupting = item.data.error.reason
    if (item.type.startsWith("execution.")) interrupting = null
    if (item.type.startsWith("execution.") && item.type !== "execution.resumed") pendingAttempt = null
    state = fold(state, [item])
    previous = item
  }
  return violations
}

function latestAssistant(state: Projection): AssistantMessage | undefined {
  return state.messages.findLast((message): message is AssistantMessage => message.kind === "assistant")
}

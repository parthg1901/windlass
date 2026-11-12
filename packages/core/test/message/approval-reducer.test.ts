/**
 * The reducer's rules about approval and taint that no scenario spells out:
 * what a fork inherits, and the wrong moves around a denial and an answer.
 */
import { describe, expect, test } from "bun:test"
import { event } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import { ReduceError, reduce } from "../../src/message/reducer.ts"
import {
  SESSION,
  approvalAnswered,
  approvalDenied,
  approvalRequested,
  called,
  escalate,
  fold,
  opening,
  position,
  ranUnder,
  SANDBOXED,
  settled,
  startedAs,
  stepEnded,
  stepStarted,
  taintCleared,
  taintNoticed,
  executionSucceeded,
  say,
} from "../scenarios/script.ts"

const TESTS = { mode: "ask" as const, name: "shell" as const, command: "bun test" }
const rejects = (events: Parameters<typeof fold>[1], next: Parameters<typeof position>[1]) => {
  const state = fold(null, events)
  try {
    reduce(state, position(state, next))
  } catch (error) {
    if (error instanceof ReduceError) return error.message
    throw error
  }
  return "accepted"
}

const asked = [...opening(), stepStarted("a1"), called("a1", "call_1", "shell", '{"command":"bun test"}'), approvalRequested("a1", "call_1", TESTS)]

describe("approval in the reducer", () => {
  test("a session approval is in the session's state from its answer on; a fork starts with none and inherits the taint", () => {
    const source = { at: 11, tool: "shell", kind: "network-command" as const, path: null }
    const parent = fold(null, [
      ...asked,
      approvalAnswered("a1", "call_1", TESTS, "session", 9),
      startedAs("a1", "call_1", "shell", ranUnder("ask", [], SANDBOXED)),
      settled("a1", "call_1", "success", "1 pass"),
      taintNoticed(source),
      stepEnded("a1", "tool_calls"),
      stepStarted("a2"),
      say("a2", "Done."),
      stepEnded("a2"),
      executionSucceeded(),
    ])
    expect(parent.session.approval?.grants).toEqual([{ scope: "session", rule: { kind: "exec-sandboxed" }, at: 9, grantedAt: 0 }])
    expect(parent.session.approval?.taint).toMatchObject({ seq: 12, source })
    const forked = reduce(parent, {
      ...event("session.created", { cwd: "/repo", title: null, lineage: { kind: "fork", parentSessionId: SESSION, throughSeq: parent.lastSeq }, settings: parent.session.settings }),
      sessionId: "ses_fork" as SessionId,
      seq: parent.lastSeq + 1,
      time: 1,
    })
    // What the user allowed in one session is not allowed in another; what the conversation holds came along.
    expect(forked.session.approval).toEqual({ grants: [], taint: parent.session.approval!.taint })
    const clean = reduce(fold(null, [...opening(), stepStarted("a1"), say("a1", "Hi."), stepEnded("a1"), executionSucceeded()]), {
      ...event("session.created", { cwd: "/repo", title: null, lineage: { kind: "fork", parentSessionId: SESSION, throughSeq: 9 }, settings: parent.session.settings }),
      sessionId: "ses_fork" as SessionId,
      seq: 10,
      time: 1,
    })
    expect(clean.session.approval).toBeUndefined()
  })

  test("the wrong moves", () => {
    const denied = [...opening(), stepStarted("a1"), called("a1", "call_1", "shell", '{"command":"curl x","sandbox":{"network":true}}'), approvalDenied("a1", "call_1", { name: "shell", command: "curl x", escalation: escalate(true) }, "unattended")]
    expect(rejects(denied, startedAs("a1", "call_1", "shell", ranUnder("auto", [], SANDBOXED)))).toContain("was denied")
    expect(rejects(denied, approvalRequested("a1", "call_1", { name: "shell", command: "curl x", escalation: escalate(true) }))).toContain("already denied")
    expect(rejects(asked, approvalDenied("a1", "call_1", TESTS, "policy"))).toContain("already asked")
    // Only a call nobody could approve ends the run.
    expect(rejects(asked.slice(0, -1), event("approval.denied", { ...approvalDenied("a1", "call_1", TESTS, "policy").data, stop: true }))).toContain("only a call nobody could approve ends the run")
    // An answer is one of the question's choices, says what that choice says, and stamps a session approval with its own position.
    const answer = approvalAnswered("a1", "call_1", TESTS, "session", 9)
    expect(rejects(asked, event("approval.answered", { ...answer.data, choice: "project" }))).toContain("offers no choice project")
    expect(rejects(asked, event("approval.answered", { ...answer.data, approve: false }))).toContain("choice session approves")
    expect(rejects(asked, event("approval.answered", { ...answer.data, grants: [] }))).toContain("the answer must record exactly that")
    expect(rejects(asked, approvalAnswered("a1", "call_1", TESTS, "session", 4))).toContain("stamped with the position of the answer")
    expect(rejects(asked, answer)).toBe("accepted")
    // A declined call does not start.
    expect(rejects([...asked, approvalAnswered("a1", "call_1", TESTS, "deny", 9)], startedAs("a1", "call_1", "shell", ranUnder("ask", [], SANDBOXED)))).toContain("was declined by the user")
    // Taint is cleared only when it is there, and its source is a result that is in the log.
    expect(rejects(asked, taintCleared())).toContain("the session is not tainted")
    expect(rejects(asked, taintNoticed({ at: 99, tool: "shell", kind: "network-command", path: null }))).toContain("a result already in the log")
  })
})

/**
 * What the integration stores about approval decisions, as validators: the
 * shapes of `decide.ts`, `paths.ts`, `escalation.ts` and `taint.ts` as they
 * are written into the session log (`event/durable.ts`) and read back. The
 * types the pure layer works with stay where they are; each validator here is
 * checked against its type, so the two cannot drift apart.
 *
 * Also here: the mapping from a session's stored events to the history the
 * taint fold reads (`taintHistory`), so that taint is a function of the log.
 */
import { toolEffect } from "../tool/tool.ts"
import { type Infer, type Validator, array, boolean, integer, literal, nonEmptyString, nullable, object, oneOf, string, variant } from "../validate.ts"
import type { Choice, Question, RunDecision } from "./decide.ts"
import type { Escalation } from "./escalation.ts"
import { type Need, grantRule, grantScope } from "./grants.ts"
import type { PathFact } from "./paths.ts"
import { approvalMode } from "./policy.ts"
import type { HistoryEntry, TaintSource } from "./taint.ts"

export const storedPathFact = object({
  given: string,
  real: nullable(string),
  place: oneOf(["workspace", "protected", "outside", "hidden"]),
  relative: nullable(string),
}) satisfies Validator<PathFact>

export const storedEscalation = object({ network: boolean, write: array(storedPathFact) }) satisfies Validator<Escalation>

export const storedNeed = variant("kind", {
  "exec-sandboxed": object({ kind: literal("exec-sandboxed") }),
  "exec-unsandboxed": object({ kind: literal("exec-unsandboxed") }),
  "sandbox-network": object({ kind: literal("sandbox-network") }),
  "sandbox-write": object({ kind: literal("sandbox-write"), path: nonEmptyString }),
  write: object({ kind: literal("write"), path: nullable(string), root: nullable(string), protectedRoot: nullable(string) }),
  "read-hidden": object({ kind: literal("read-hidden"), path: nonEmptyString }),
  tool: object({ kind: literal("tool"), tool: nonEmptyString }),
}) satisfies Validator<Need>

export const storedRunDecision = variant("kind", {
  run: object({ kind: literal("run") }),
  run_sandboxed: object({ kind: literal("run_sandboxed"), network: boolean, writableRoots: array(string) }),
}) satisfies Validator<RunDecision>

export const choiceId = oneOf(["once", "session", "project", "deny"])
export type ChoiceId = Infer<typeof choiceId>

export const storedChoice = object({
  id: choiceId,
  label: string,
  approve: boolean,
  remembers: nullable(string),
  grants: array(object({ scope: grantScope, rule: grantRule })),
}) satisfies Validator<Choice>

export const storedQuestion = object({ title: string, subject: string, details: array(string), choices: array(storedChoice) }) satisfies Validator<Question>

export const storedTaintSource = object({
  at: integer(0),
  tool: nonEmptyString,
  kind: oneOf(["network-tool", "mcp-tool", "outside-file", "untrusted-file", "network-command"]),
  path: nullable(string),
}) satisfies Validator<TaintSource>

/** How a command ran inside the sandbox: with the network or not, and what it could write besides the workspace and the temp directory. */
export const sandboxRun = object({ network: boolean, writableRoots: array(string) })
export type SandboxRunRecord = Infer<typeof sandboxRun>

/**
 * What a call that started ran under, recorded with `tool.started`: the mode
 * in force, where the tool comes from, the path facts the decision was made
 * from (never derived from the disk again), and for a command whether it ran
 * in the sandbox (`null`: it did not) and with which extra access.
 */
export const callRun = object({
  mode: approvalMode,
  origin: oneOf(["builtin", "mcp"]),
  paths: array(storedPathFact),
  sandbox: nullable(sandboxRun),
})
export type CallRun = Infer<typeof callRun>

/** The events `taintHistory` reads, reduced to what it needs of them. */
export type TaintEvent =
  | { readonly type: "tool.called"; readonly data: { readonly messageId: string; readonly callId: string; readonly name: string } }
  | { readonly type: "tool.started"; readonly data: { readonly messageId: string; readonly callId: string; readonly effect: Infer<typeof toolEffect>; readonly run?: CallRun } }
  | { readonly type: "tool.settled"; readonly seq: number; readonly data: { readonly messageId: string; readonly callId: string } }
  | { readonly type: "taint.cleared"; readonly seq: number }
  | { readonly type: "compaction.ended"; readonly seq: number }

/**
 * Folds stored events into the history `deriveTaint` reads, oldest first. A
 * result counts when its call started: a call that was denied, declined or
 * never began brought nothing in. Feed it every event of the log in order;
 * it keeps what it needs of the calls that are still open.
 */
export class TaintHistory {
  readonly entries: HistoryEntry[] = []
  private readonly names = new Map<string, string>()
  private readonly started = new Map<string, { readonly effect: Infer<typeof toolEffect>; readonly run: CallRun | undefined }>()

  add(item: { readonly type: string; readonly seq?: number; readonly data?: unknown }): void {
    const event = item as TaintEvent
    switch (event.type) {
      case "tool.called":
        this.names.set(key(event.data), event.data.name)
        return
      case "tool.started":
        this.started.set(key(event.data), { effect: event.data.effect, run: event.data.run })
        return
      case "tool.settled": {
        const id = key(event.data)
        const began = this.started.get(id)
        const tool = this.names.get(id)
        this.started.delete(id)
        this.names.delete(id)
        if (began === undefined || tool === undefined) return
        this.entries.push({
          kind: "tool_result",
          at: event.seq,
          tool,
          effect: began.effect,
          origin: began.run?.origin ?? "builtin",
          // The paths whose content the result may show. A tool that writes shows none of what was in the file (a line
          // count, a line number), so writing outside the workspace brings nothing into the conversation; reading does.
          paths: began.effect === "read" ? (began.run?.paths ?? []) : [],
          networkGranted: began.run?.sandbox?.network ?? false,
        })
        return
      }
      case "taint.cleared":
        this.entries.push({ kind: "taint_cleared", at: event.seq })
        return
      case "compaction.ended":
        this.entries.push({ kind: "compaction", at: event.seq })
        return
    }
  }
}

function key(data: { readonly messageId: string; readonly callId: string }) {
  return `${data.messageId}/${data.callId}`
}

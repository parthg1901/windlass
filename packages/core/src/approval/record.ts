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
import { type Infer, type Validator, array, boolean, integer, literal, nonEmptyString, nullable, object, oneOf, optional, string, variant } from "../validate.ts"
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
  records: object({ kind: literal("records"), tool: nonEmptyString }),
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
  kind: oneOf(["network-tool", "mcp-tool", "outside-file", "untrusted-file", "network-command", "subagent", "wake-up"]),
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

/**
 * One entry of the history taint is folded from (`HistoryEntry` in
 * `taint.ts`), as a fork's `session.created` stores the entries of its
 * inherited history.
 */
export const storedHistoryEntry = variant("kind", {
  tool_result: object({
    kind: literal("tool_result"),
    at: integer(0),
    tool: nonEmptyString,
    effect: toolEffect,
    origin: oneOf(["builtin", "mcp"]),
    paths: array(storedPathFact),
    networkGranted: boolean,
    untrusted: optional(nullable(boolean)),
  }),
  subagent_result: object({ kind: literal("subagent_result"), at: integer(0), session: nonEmptyString }),
  untrusted_input: object({ kind: literal("untrusted_input"), at: integer(0), wakeId: nonEmptyString, carries: oneOf(["webhook_body", "check_output"]) }),
  taint_cleared: object({ kind: literal("taint_cleared"), at: integer(0) }),
  compaction: object({ kind: literal("compaction"), at: integer(0) }),
}) satisfies Validator<HistoryEntry>

/**
 * What a fork carries of its parent's taint history, so that deciding its
 * calls never needs the parent's log: the entries since the conversation
 * was last declared trustworthy that can be a source under some policy.
 * Left out are the entries that never are one, whatever the policy says
 * (a write, a command without granted network, a tool that names no path,
 * a bridge result that holds nothing untrusted, a compaction), so
 * `deriveTaint` gives the same answer over the carried entries as over the
 * inherited events, for every `untrustedPaths`.
 */
export function inheritableTaint(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const cleared = entries.findLastIndex((entry) => entry.kind === "taint_cleared")
  return entries.slice(cleared + 1).filter((entry) => {
    if (entry.kind === "compaction") return false
    if (entry.kind !== "tool_result") return true
    if (entry.untrusted != null) return entry.untrusted
    if (entry.origin === "mcp" || entry.effect === "network") return true
    if (entry.effect === "exec") return entry.networkGranted
    return entry.paths.length > 0
  })
}

/** The events `taintHistory` reads, reduced to what it needs of them. */
export type TaintEvent =
  | { readonly type: "tool.called"; readonly data: { readonly messageId: string; readonly callId: string; readonly name: string } }
  | { readonly type: "tool.started"; readonly data: { readonly messageId: string; readonly callId: string; readonly effect: Infer<typeof toolEffect>; readonly run?: CallRun } }
  | { readonly type: "tool.settled"; readonly seq: number; readonly data: { readonly messageId: string; readonly callId: string; readonly display?: unknown } }
  | { readonly type: "inbox.enqueued"; readonly seq: number; readonly data: { readonly untrusted?: { readonly wakeId: string; readonly carries: "webhook_body" | "check_output" } } }
  | { readonly type: "taint.cleared"; readonly seq: number }
  | { readonly type: "spawn.started"; readonly data: { readonly spawnId: string; readonly work: { readonly kind: string; readonly sessionId?: string } } }
  | { readonly type: "spawn.ended"; readonly seq: number; readonly data: { readonly spawnId: string; readonly tainted: boolean } }
  | { readonly type: "compaction.ended"; readonly seq: number }

/**
 * Folds stored events into the history `deriveTaint` reads, oldest first. A
 * result counts when its call started: a call that was denied, declined or
 * never began brought nothing in. Feed it every event of the log in order;
 * it keeps what it needs of the calls that are still open. A fork is fed
 * its own events only, after `seed` gave it the entries its
 * `session.created` carries of the history it inherited.
 */
export class TaintHistory {
  readonly entries: HistoryEntry[] = []
  private readonly names = new Map<string, string>()
  private readonly started = new Map<string, { readonly effect: Infer<typeof toolEffect>; readonly run: CallRun | undefined }>()
  /** The child session of each subagent that is running, by its spawned work. */
  private readonly children = new Map<string, string>()

  /** The entries of a history that is not fed event by event: what a fork inherited. Before the first `add`. */
  seed(entries: readonly HistoryEntry[]): void {
    this.entries.push(...entries)
  }

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
        const bridge = bridgeResult(event.data.display)
        this.entries.push({
          kind: "tool_result",
          at: event.seq,
          // A bridge call is named by the server's tool it reached: that is what the user is told the content came from.
          tool: bridge?.tool ?? tool,
          effect: began.effect,
          origin: began.run?.origin ?? "builtin",
          // The paths whose content the result may show. A tool that writes shows none of what was in the file (a line
          // count, a line number), so writing outside the workspace brings nothing into the conversation; reading does.
          paths: began.effect === "read" ? (began.run?.paths ?? []) : [],
          networkGranted: began.run?.sandbox?.network ?? false,
          untrusted: bridge?.untrusted ?? null,
        })
        return
      }
      case "inbox.enqueued":
        if (event.data.untrusted !== undefined) this.entries.push({ kind: "untrusted_input", at: event.seq, wakeId: event.data.untrusted.wakeId, carries: event.data.untrusted.carries })
        return
      case "taint.cleared":
        this.entries.push({ kind: "taint_cleared", at: event.seq })
        return
      case "spawn.started":
        if (event.data.work.sessionId !== undefined) this.children.set(event.data.spawnId, event.data.work.sessionId)
        return
      case "spawn.ended": {
        const child = this.children.get(event.data.spawnId)
        this.children.delete(event.data.spawnId)
        if (event.data.tainted && child !== undefined) this.entries.push({ kind: "subagent_result", at: event.seq, session: child })
        return
      }
      case "compaction.ended":
        this.entries.push({ kind: "compaction", at: event.seq })
        return
    }
  }
}

/**
 * What an MCP bridge call recorded about its result in the result's
 * `display` (`mcp`; see `mcp/bridge.ts`, `McpResultSource`): whether it
 * holds content an untrusted server wrote, and the server's tool it came
 * from (`github/create_issue`; the bridge tool's own name for a search).
 * `null` for a result that carries no such record. Fields of the stored
 * event, never the model-facing text.
 */
export function bridgeResult(display: unknown): { readonly untrusted: boolean; readonly tool: string | null } | null {
  if (typeof display !== "object" || display === null || Array.isArray(display)) return null
  const source = (display as { readonly mcp?: unknown }).mcp
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null
  const { untrusted, servers, tool, kind } = source as { readonly untrusted?: unknown; readonly servers?: unknown; readonly tool?: unknown; readonly kind?: unknown }
  if (typeof untrusted !== "boolean") return null
  const server = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null
  return { untrusted, tool: kind === "call" && server !== null && typeof tool === "string" ? `${server}/${tool}` : null }
}

function key(data: { readonly messageId: string; readonly callId: string }) {
  return `${data.messageId}/${data.callId}`
}

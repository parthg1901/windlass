/**
 * A session together with the subagents it spawned. A subagent is a session
 * of its own, with a log of its own; its executions are placed in its
 * parent's trace, under the span of the spawned work that started them, the
 * way context propagation would have put them had the spans been made live.
 * The spawn span also carries a link to each of them.
 *
 * Asked for a subagent, the export first reads up its lineage, so the
 * child's spans land in the trace its parent's turn has; when a parent cannot
 * be read, the child's executions are traces of their own and carry the
 * parent's session and spawn as attributes.
 */
import { type MapOptions, type MapResult, type SessionInput, mapSession } from "./map.ts"
import type { Span, SpanContext } from "./span.ts"
import { spanIdOf } from "./span.ts"

/** Reads a session's events and ledger rows, or `null` when the session is not there. */
export type SessionReader = (sessionId: string) => SessionInput | null

export interface TreeOptions extends Omit<MapOptions, "placement"> {
  /** Include the subagents' sessions (default `true`). */
  readonly children?: boolean
  /** How deep to follow subagents of subagents. Default 4. */
  readonly maxDepth?: number
}

export interface TreeResult {
  readonly sessionId: string
  /** Every span: the session's, then each child's, depth first. */
  readonly spans: readonly Span[]
  /** The sessions that were mapped, the asked one first. */
  readonly sessions: readonly string[]
  /** Children the parent names that could not be read. */
  readonly missing: readonly string[]
  /** Unknown event types over all mapped sessions. */
  readonly unknownEvents: Readonly<Record<string, number>>
  readonly stepsWithoutLedger: number
}

/** Maps `sessionId`, placed under its parents when they can be read, and (unless told not to) its subagents. */
export function mapSessionTree(read: SessionReader, sessionId: string, options: TreeOptions = {}): TreeResult {
  const input = read(sessionId)
  if (input === null) throw new Error(`no session ${sessionId}`)
  const placement = placementFromParents(read, input, options, 0)
  const out = { spans: [] as Span[], sessions: [] as string[], missing: [] as string[], unknown: {} as Record<string, number>, steps: 0 }
  walk(read, input, placement, options, 0, out)
  return { sessionId, spans: out.spans, sessions: out.sessions, missing: out.missing, unknownEvents: out.unknown, stepsWithoutLedger: out.steps }
}

type Placement = MapOptions["placement"]

function walk(read: SessionReader, input: SessionInput, placement: Placement, options: TreeOptions, depth: number, out: { spans: Span[]; sessions: string[]; missing: string[]; unknown: Record<string, number>; steps: number }) {
  const result = mapSession(input, { ...options, ...(placement === undefined ? {} : { placement }) })
  out.sessions.push(input.sessionId)
  for (const [type, count] of Object.entries(result.unknownEvents)) out.unknown[type] = (out.unknown[type] ?? 0) + count
  out.steps += result.stepsWithoutLedger
  const spans = [...result.spans]
  out.spans.push(...spans)
  if (options.children === false || depth >= (options.maxDepth ?? 4)) return
  for (const childId of [...new Set(result.spawns.flatMap((spawn) => (spawn.childSessionId === null ? [] : [spawn.childSessionId])))]) {
    const childInput = read(childId)
    if (childInput === null) {
      out.missing.push(childId)
      continue
    }
    const before = out.spans.length
    walk(read, childInput, placementIn(result, childId), options, depth + 1, out)
    // The spawn span links to each child execution placed under it.
    const roots = out.spans.slice(before).filter((span) => span.sessionId === childId && span.attributes["gen_ai.operation.name"] === "invoke_agent")
    for (const root of roots) {
      const index = out.spans.findIndex((span) => span.spanId === root.parentSpanId && span.traceId === root.traceId)
      if (index === -1) continue
      const spawn = out.spans[index]!
      out.spans[index] = { ...spawn, links: [...spawn.links, { traceId: root.traceId, spanId: root.spanId, attributes: { "gen_ai.conversation.id": childId } }] }
    }
  }
}

/**
 * Where a child's executions go in its parent's result: under the latest
 * spawn of that child that started no later than the execution did (a
 * follow-up to a finished subagent is a new piece of spawned work).
 */
function placementIn(parent: MapResult, childId: string): Placement {
  const pieces = parent.spawns.filter((spawn) => spawn.childSessionId === childId).toSorted((a, b) => a.startMs - b.startMs)
  if (pieces.length === 0) return undefined
  return (execution): SpanContext => {
    let chosen = pieces[0]!
    for (const piece of pieces) if (piece.startMs <= execution.timeMs) chosen = piece
    return chosen.context
  }
}

/** For a subagent asked for on its own: its parents' placement, read up the lineage as far as the logs exist. */
function placementFromParents(read: SessionReader, input: SessionInput, options: TreeOptions, depth: number): Placement {
  const lineage = mapSession({ ...input, requests: [] }, {}).spawnedBy
  if (lineage === null || depth >= (options.maxDepth ?? 4)) return undefined
  const parentInput = read(lineage.parentSessionId)
  if (parentInput === null) return undefined
  const grand = placementFromParents(read, parentInput, options, depth + 1)
  const parent = mapSession({ ...parentInput, requests: [] }, grand === undefined ? {} : { placement: grand })
  const placed = placementIn(parent, input.sessionId)
  if (placed !== undefined) return placed
  // The parent's log names the spawn, but not this child (it should); fall back to the span the spawn ID names.
  const spawn = parent.spawns.find((entry) => entry.spawnId === lineage.spawnId)
  return spawn === undefined ? undefined : () => ({ traceId: spawn.context.traceId, spanId: spanIdOf(lineage.parentSessionId, "spawn", lineage.spawnId) })
}

/**
 * What the loop reads off the log about the working tree: which snapshot was
 * current when a message was delivered, and which files changed outside the
 * harness's own work. Pure functions of the stored events, plus one that
 * asks the snapshot store to diff.
 */
import type { EventData, SkippedFile, SnapshotPoint, StoredEvent } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import type { Projection } from "../message/message.ts"
import type { Snapshot, SnapshotUnavailable, Snapshots } from "../snapshot/index.ts"

/**
 * The part of the snapshot module the loop uses. A test hands the engine a
 * scripted one. Without `prune` nothing is ever dropped; without `list`
 * nobody can tell whether another session works in the same directory, and
 * the session is taken to be alone in it.
 */
export type WorkspaceSnapshots = Pick<Snapshots, "workspace" | "take" | "changedFiles" | "restore"> & Partial<Pick<Snapshots, "prune" | "list">>

/** Opens the snapshots of a working directory, or says why there are none. */
export type OpenSnapshots = (cwd: string) => Promise<WorkspaceSnapshots | SnapshotUnavailable>

/** One recorded snapshot, in log order. */
export interface SnapshotMark {
  readonly id: string
  readonly point: SnapshotPoint
  readonly messageId: MessageId | null
  readonly seq: number
}

const mark = (item: StoredEvent<"snapshot.taken">): SnapshotMark => ({ id: item.data.id, point: item.data.point, messageId: item.data.messageId, seq: item.seq })

/**
 * The snapshot that was current when the message created at `seq` was
 * delivered, and every snapshot recorded from it on. `target` is `null` when
 * no snapshot was taken for that delivery (snapshots were off or unavailable
 * then), in which case its files cannot be restored.
 */
export function snapshotsSinceDelivery(events: readonly StoredEvent[], seq: number): { readonly target: string | null; readonly timeline: readonly SnapshotMark[] } {
  // The delivery snapshot is the last thing recorded about the workspace before the message entered history.
  const index = events.findLastIndex((item) => item.seq < seq && (item.type === "snapshot.taken" || item.type === "snapshot.unavailable"))
  const found = events[index]
  if (found === undefined || found.type !== "snapshot.taken" || found.data.point !== "delivery") return { target: null, timeline: [] }
  return { target: found.data.id, timeline: snapshotsAfter(events, found.seq - 1) }
}

/** Every snapshot recorded after `afterSeq`, in order. */
export function snapshotsAfter(events: readonly StoredEvent[], afterSeq: number): SnapshotMark[] {
  return events.flatMap((item) => (item.type === "snapshot.taken" && item.seq > afterSeq ? [mark(item)] : []))
}

/** The first `delivery` snapshot recorded after `afterSeq`: the workspace as it was when the execution's first input arrived. */
export function firstDelivery(events: readonly StoredEvent[], afterSeq: number): string | null {
  return snapshotsAfter(events, afterSeq).find((item) => item.point === "delivery")?.id ?? null
}

/**
 * Whether the stretch that begins at a snapshot taken at `point` is the
 * harness's own work: a step's tools, a run of checks, a restore. It runs to
 * the next snapshot in the log, which is the matching end point, or, when the
 * work was cut short, whatever was recorded next.
 */
export function isHarnessWork(point: SnapshotPoint): boolean {
  return point === "step_start" || point === "checks_start" || point === "restore_start"
}

/**
 * Whose a stretch of the session's own work is, when another session was at
 * work in the same directory: the paths its tools themselves wrote. Any
 * other path that changed in that stretch may be the other session's.
 */
export type OwnPaths = (from: Pick<SnapshotMark, "id" | "point"> & Partial<Pick<SnapshotMark, "messageId">>) => ReadonlySet<string>

/**
 * The paths that changed outside the harness's own work along `timeline` and
 * from its last snapshot to `now`: between turns, between steps, after the
 * last turn. Nothing but a person (or a process they started, or another
 * session) changes files there, so a restore that would overwrite one of
 * them must say so first.
 *
 * Inside the session's own work (a step's tools, a run of checks, a
 * restore) every change is the session's, as long as it is alone in the
 * directory. When it is not, `own` is given: of the changes in such a
 * stretch only the paths it names are the session's own, and the rest count
 * as edited by someone else.
 */
export async function handEditedPaths(
  store: Pick<WorkspaceSnapshots, "changedFiles">,
  timeline: readonly (Pick<SnapshotMark, "id" | "point"> & Partial<Pick<SnapshotMark, "messageId">>)[],
  now: string,
  own?: OwnPaths,
): Promise<string[]> {
  const paths = new Set<string>()
  for (const [index, from] of timeline.entries()) {
    const to = timeline[index + 1]?.id ?? now
    if (from.id === to) continue
    const work = isHarnessWork(from.point)
    if (work && own === undefined) continue
    const mine = work ? own!(from) : null
    for (const path of await store.changedFiles(from.id as never, to as never)) if (mine === null || !mine.has(path)) paths.add(path)
  }
  return [...paths].sort()
}

/** What a snapshot left out, in the shape and order `snapshot.coverage` records. */
export function coverageOf(snapshot: Pick<Snapshot, "skipped" | "nestedRepositories">): EventData<"snapshot.coverage"> {
  const skipped: SkippedFile[] = snapshot.skipped.map((file) => ({ path: file.path, reason: file.reason, bytes: file.reason === "too_large" ? file.bytes : null }))
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return { skipped: skipped.sort((a, b) => byPath(a.path, b.path)), nestedRepositories: [...snapshot.nestedRepositories].sort(byPath) }
}

/**
 * The snapshots a revert or an undo of the session could still need, which
 * retention therefore never removes:
 *
 * - the snapshot current when each user message was delivered that a revert
 *   can still go back to (in the model's history, after the latest
 *   compaction): what the workspace is restored to;
 * - everything recorded since the latest of those messages: an undo of the
 *   last turn tells the agent's changes from changes made by hand (or by
 *   another session) by comparing them. A revert further back, across
 *   snapshots that were dropped, cannot tell and asks about every file
 *   instead of overwriting one silently;
 * - both ends of every revert that can still be undone, everything recorded
 *   since the latest one, and both ends of a restore that is open;
 * - the latest snapshot, and the ones the verification gate compares with.
 *
 * `events` is the session's own log (a fork's inherited snapshots belong to
 * its parent's refs).
 */
export function neededSnapshots(projection: Projection, events: readonly StoredEvent[]): string[] {
  const session = projection.session
  const needed = new Set<string>()
  const keep = (id: string | null | undefined) => {
    if (id !== null && id !== undefined) needed.add(id)
  }
  keep(session.workspace.snapshot?.id)
  keep(session.verification.verified?.snapshot)
  keep(session.verification.latest?.snapshot)
  const floor = session.compaction?.seq ?? 0
  const targets = projection.messages.filter((message) => message.kind === "user" && message.excluded === null && message.seq > floor)
  for (const message of targets) keep(snapshotsSinceDelivery(events, message.seq).target)
  const latest = targets.at(-1)
  if (latest !== undefined) for (const item of snapshotsSinceDelivery(events, latest.seq).timeline) keep(item.id)
  for (const revert of session.reverts) {
    keep(revert.before)
    keep(revert.after)
  }
  const undoable = session.reverts.at(-1)
  if (undoable !== undefined) for (const item of snapshotsAfter(events, undoable.seq)) keep(item.id)
  const open = session.open
  if (open !== null && (open.kind === "revert" || open.kind === "undo")) {
    keep(open.target)
    keep(open.before)
  }
  return [...needed]
}

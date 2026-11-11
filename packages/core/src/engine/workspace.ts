/**
 * What the loop reads off the log about the working tree: which snapshot was
 * current when a message was delivered, and which files changed outside the
 * harness's own work. Pure functions of the stored events, plus one that
 * asks the snapshot store to diff.
 */
import type { EventData, SkippedFile, SnapshotPoint, StoredEvent } from "../event/durable.ts"
import type { MessageId } from "../id.ts"
import type { Snapshot, SnapshotUnavailable, Snapshots } from "../snapshot/index.ts"

/** The part of the snapshot module the loop uses. A test hands the engine a scripted one. */
export type WorkspaceSnapshots = Pick<Snapshots, "workspace" | "take" | "changedFiles" | "restore">

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
 * The paths that changed outside the harness's own work along `timeline` and
 * from its last snapshot to `now`: between turns, between steps, after the
 * last turn. Nothing but a person (or a process they started) changes files
 * there, so a restore that would overwrite one of them must say so first.
 */
export async function handEditedPaths(store: Pick<WorkspaceSnapshots, "changedFiles">, timeline: readonly Pick<SnapshotMark, "id" | "point">[], now: string): Promise<string[]> {
  const paths = new Set<string>()
  for (const [index, from] of timeline.entries()) {
    const to = timeline[index + 1]?.id ?? now
    if (from.id === to || isHarnessWork(from.point)) continue
    for (const path of await store.changedFiles(from.id as never, to as never)) paths.add(path)
  }
  return [...paths].sort()
}

/** What a snapshot left out, in the shape and order `snapshot.coverage` records. */
export function coverageOf(snapshot: Pick<Snapshot, "skipped" | "nestedRepositories">): EventData<"snapshot.coverage"> {
  const skipped: SkippedFile[] = snapshot.skipped.map((file) => ({ path: file.path, reason: file.reason, bytes: file.reason === "too_large" ? file.bytes : null }))
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return { skipped: skipped.sort((a, b) => byPath(a.path, b.path)), nestedRepositories: [...snapshot.nestedRepositories].sort(byPath) }
}

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

/** The snapshots around one turn of a stored session: from the workspace when its input was delivered to the last one recorded before it ended. */
export interface TurnRange {
  /** The `seq` of the event that ended the turn: `turn.ended`, or its execution's terminal event. */
  readonly endSeq: number
  readonly executionId: string
  /** `null` when no snapshot was recorded for the turn's input (snapshots were off or unavailable then). */
  readonly from: string | null
  readonly to: string | null
}

/**
 * Every turn of a log that has ended, in order, with the snapshots that
 * bound it. A turn begins with the first input delivered under an execution
 * and again with every queued message, which follows a `turn.ended`; a
 * steer belongs to the turn it redirects. Its `delivery` snapshot is the one
 * recorded right before that input entered history (for a queued message
 * that is before the `turn.ended` of the turn in front of it), and its last
 * snapshot is whatever was recorded last before the event that ends it. An
 * execution that was shut down and resumed is one turn: its entry at the
 * shutdown is followed by one at its real end, from the same beginning.
 */
export function turnRanges(events: readonly StoredEvent[]): TurnRange[] {
  const turns: TurnRange[] = []
  let execution: string | null = null
  /** Whether the turn in progress has its input. */
  let begun = false
  let from: string | null = null
  let last: string | null = null
  /** A `delivery` snapshot whose input has not entered history yet. */
  let waiting: string | null = null
  const end = (seq: number) => {
    if (execution !== null) turns.push({ endSeq: seq, executionId: execution, from: begun ? from : null, to: begun ? last : null })
  }
  for (const item of events) {
    switch (item.type) {
      case "execution.started":
        execution = item.data.executionId
        begun = false
        from = last = waiting = null
        break
      case "snapshot.taken":
        if (item.data.point === "delivery") waiting = item.data.id
        else if (begun) last = item.data.id
        break
      case "snapshot.unavailable":
        waiting = null
        break
      case "inbox.delivered":
        if (!begun) {
          begun = true
          from = last = waiting
        } else if (waiting !== null && from !== null) last = waiting
        waiting = null
        break
      case "turn.ended":
        end(item.seq)
        // The delivery snapshot recorded just before belongs to the queued message that follows.
        begun = false
        from = last = null
        break
      case "execution.succeeded":
      case "execution.failed":
        end(item.seq)
        execution = null
        break
      case "execution.interrupted":
        end(item.seq)
        // A shutdown keeps the claim: the turn goes on when the execution is resumed.
        if (item.data.reason === "user") execution = null
        break
      default:
        break
    }
  }
  return turns
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
 * Whose a stretch of the session's own work is: the paths that are surely
 * the session's own among the ones that changed in it. Any other path that
 * changed in that stretch may be someone else's (the user's, another
 * session's), and a restore asks before it overwrites one. The engine's
 * `ownPathsSince` has the rule.
 */
export type OwnPaths = (from: Pick<SnapshotMark, "id" | "point"> & Partial<Pick<SnapshotMark, "messageId">>) => { has(path: string): boolean }

/**
 * The paths the arguments of a call name, for a call that can change files
 * without saying which (a command, a call to a server's tool): every word of
 * every string in its arguments, read as a path of the workspace. A word is
 * split off at whitespace, quotes and the shell's operators; `./` in front
 * and `/` behind are dropped, an absolute path below `cwd` is made relative,
 * a pattern (`src/**` + `/*.ts`) names the directory before its first
 * wildcard, and a word that is empty, `.` or leads out of the workspace
 * names nothing. `directory` says whether the word was written with a `/`:
 * only then does it name what lies below it (`bun test` does not name the
 * directory `test`; `bun test test/engine` names `test/engine`).
 */
export function namedPaths(input: string, cwd: string): { readonly path: string; readonly directory: boolean }[] {
  const strings: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect)
  }
  try {
    collect(JSON.parse(input))
  } catch {
    strings.push(input)
  }
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`
  const named = new Map<string, boolean>()
  for (const word of strings.flatMap((value) => value.split(/[\s"'`;|&()<>=,]+/))) {
    let path = word.startsWith(root) ? word.slice(root.length) : word
    if (path.startsWith("/")) continue
    const wildcard = path.search(/[*?[{]/)
    if (wildcard !== -1) path = path.slice(0, path.lastIndexOf("/", wildcard) + 1)
    const directory = path.includes("/")
    while (path.startsWith("./")) path = path.slice(2)
    path = path.replace(/\/+$/, "")
    if (path === "" || path === "." || path.split("/").includes("..")) continue
    named.set(path, (named.get(path) ?? false) || directory)
  }
  return [...named].map(([path, directory]) => ({ path, directory }))
}

/** Whether one of the named paths is `path`, or a directory above it that was named as one. */
export function isNamed(named: readonly { readonly path: string; readonly directory: boolean }[], path: string): boolean {
  return named.some((entry) => entry.path === path || (entry.directory && path.startsWith(`${entry.path}/`)))
}

/**
 * The paths that changed outside the harness's own work along `timeline` and
 * from its last snapshot to `now`: between turns, between steps, after the
 * last turn. Nothing but a person (or a process they started, or another
 * session) changes files there, so a restore that would overwrite one of
 * them must say so first.
 *
 * Inside the session's own work (a step's tools, a run of checks, a
 * restore) `own` says which of the changes are surely the session's: the
 * rest count as possibly edited by someone else. Without `own` every change
 * in such a stretch is the session's.
 */
export async function handEditedPaths(
  store: Pick<WorkspaceSnapshots, "changedFiles">,
  timeline: readonly (Pick<SnapshotMark, "id" | "point"> & Partial<Pick<SnapshotMark, "messageId">>)[],
  now: string,
  own?: OwnPaths,
): Promise<string[]> {
  return [...(await editedOutside(store, timeline, now, own)).keys()].sort()
}

/**
 * The same paths, each with where its change fell: `between` the stretches
 * of the session's own work (nothing of the harness ran there, so it was
 * the user, another program or another session), or only `during` one of
 * them, which is asked about because nothing the session's own calls say
 * names the path: the user may have edited it while a command ran, or
 * another session at work in the directory may have. There the session's
 * own command may have changed it as well. A path that changed in both is
 * `between`.
 */
export async function editedOutside(
  store: Pick<WorkspaceSnapshots, "changedFiles">,
  timeline: readonly (Pick<SnapshotMark, "id" | "point"> & Partial<Pick<SnapshotMark, "messageId">>)[],
  now: string,
  own?: OwnPaths,
): Promise<Map<string, "between" | "during">> {
  const paths = new Map<string, "between" | "during">()
  for (const [index, from] of timeline.entries()) {
    const to = timeline[index + 1]?.id ?? now
    if (from.id === to) continue
    const work = isHarnessWork(from.point)
    if (work && own === undefined) continue
    const mine = work ? own!(from) : null
    for (const path of await store.changedFiles(from.id as never, to as never)) {
      if (mine === null) paths.set(path, "between")
      else if (!mine.has(path) && !paths.has(path)) paths.set(path, "during")
    }
  }
  return paths
}

/**
 * The paths that changed inside another session's own work (a step's tools,
 * a run of checks, a restore), read off that session's log from `sinceTime`
 * on: what a revert plan says that session changed. Its last stretch, when
 * nothing was recorded after it, runs to `now`.
 */
export async function changedInOwnWork(store: Pick<WorkspaceSnapshots, "changedFiles">, events: readonly StoredEvent[], sinceTime: number, now: string): Promise<Set<string>> {
  const marks = events.flatMap((item) => (item.type === "snapshot.taken" && item.time >= sinceTime ? [mark(item)] : []))
  const paths = new Set<string>()
  for (const [index, from] of marks.entries()) {
    if (!isHarnessWork(from.point)) continue
    const to = marks[index + 1]?.id ?? now
    if (from.id === to) continue
    for (const path of await store.changedFiles(from.id as never, to as never)) paths.add(path)
  }
  return paths
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
 *   can still go back to (every one that is not excluded, also before a
 *   compaction: a revert may go back past one): what the workspace is
 *   restored to;
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
  const targets = projection.messages.filter((message) => message.kind === "user" && message.excluded === null)
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

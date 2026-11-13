/**
 * Which calls of one model response may run at the same time: by what they
 * touch, not by their effect class alone. Pure, with no dependency: the
 * caller says what each call is (its effect class, where it comes from, the
 * paths it names with links followed), and the schedule says what it waits
 * for. See the README for the rules and why.
 */
import { isWithin } from "../approval/paths.ts"
import type { ToolEffect } from "../tool/tool.ts"

/** One path a call names: as the tool resolves it, and with every link followed (`null` when that failed). */
export interface PathKey {
  readonly lexical: string
  readonly real: string | null
}

/**
 * What a call can disturb, for scheduling.
 * - `none`: nothing another call of the response depends on (a read, a subagent, a tool nobody knows, a network call of the harness's own).
 * - `files`: exactly these paths (a write or an edit that names them).
 * - `command`: anything a process can reach (a command, an MCP server's tool, which runs outside the sandbox).
 * - `unknown`: a call that changes something and names nothing (a write with no path argument).
 */
export type Footprint =
  | { readonly kind: "none" }
  | { readonly kind: "files"; readonly paths: readonly PathKey[] }
  | { readonly kind: "command" }
  | { readonly kind: "unknown" }

export interface CallTraits {
  /** `undefined` for a tool nobody knows: the runtime refuses it before it could do anything. */
  readonly effect: ToolEffect | undefined
  readonly origin: "builtin" | "mcp"
  /** The call hands its work to a subagent, whose own calls are decided and scheduled in its own session. */
  readonly delegates: boolean
  /** The paths the call names (`Tool.touches`), resolved. */
  readonly paths: readonly PathKey[]
}

export function footprintOf(call: CallTraits): Footprint {
  if (call.effect === undefined || call.effect === "read" || call.delegates) return { kind: "none" }
  if (call.origin === "mcp" || call.effect === "exec") return { kind: "command" }
  if (call.effect === "network") return { kind: "none" }
  return call.paths.length === 0 ? { kind: "unknown" } : { kind: "files", paths: call.paths }
}

/** Whether two paths are one, or one lies inside the other, by either spelling. A path whose links could not be followed meets every path. */
export function overlaps(a: PathKey, b: PathKey): boolean {
  if (a.real === null || b.real === null) return true
  const spellings = (key: PathKey) => (key.real === key.lexical ? [key.lexical] : [key.lexical, key.real!])
  return spellings(a).some((x) => spellings(b).some((y) => isWithin(x, y) || isWithin(y, x)))
}

/**
 * Whether one of the two must wait for the other. Symmetric.
 * - Calls that touch nothing meet nothing.
 * - Two commands do not meet: the model asked for them in one response, before it saw either result.
 * - A command meets every write: it could change the file a write was decided about (or put a link in its way).
 * - Two writes meet when their paths overlap; a write that names nothing meets every write.
 */
export function conflicts(a: Footprint, b: Footprint): boolean {
  if (a.kind === "none" || b.kind === "none") return false
  if (a.kind === "command" && b.kind === "command") return false
  if (a.kind === "files" && b.kind === "files") return a.paths.some((x) => b.paths.some((y) => overlaps(x, y)))
  return true
}

/**
 * The calls of one response in the order the model wrote them. A call
 * starts once every earlier call it conflicts with is done, so calls that
 * conflict run in model order and the rest run side by side. `start` runs
 * synchronously when nothing is in the way: with nothing to wait for, calls
 * start in the order they were added.
 */
export class CallSchedule {
  private readonly entries: { readonly footprint: Footprint; readonly done: Promise<void> }[] = []

  /**
   * Adds the next call. `start` is called when its turn comes (`waited`
   * says whether it had to wait), and the call is done when the promise it
   * returns settles, either way. `onWait` is called, synchronously, when the
   * call has to wait. Returns the call's own `done`.
   */
  add(footprint: Footprint, start: (waited: boolean) => Promise<void>, onWait?: () => void): Promise<void> {
    const ahead = this.entries.filter((entry) => conflicts(entry.footprint, footprint)).map((entry) => entry.done)
    const settled = (work: Promise<void>) => work.then(
      () => {},
      () => {},
    )
    let done: Promise<void>
    if (ahead.length === 0) done = settled(start(false))
    else {
      onWait?.()
      done = Promise.all(ahead).then(() => settled(start(true)))
    }
    this.entries.push({ footprint, done })
    return done
  }

  /** How many calls were added. */
  get size(): number {
    return this.entries.length
  }
}

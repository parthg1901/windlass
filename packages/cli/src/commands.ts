/**
 * The interactive commands that act on the session instead of talking to the
 * agent: `/undo` goes back to before the last turn (the files and the
 * conversation), `/redo` undoes that.
 *
 * Both say what they are about to do before they do it. `/undo` never
 * overwrites a file the user edited by hand since that turn without asking:
 * the engine reports those files, and the command asks whether to overwrite
 * them (nothing is lost: `/redo` brings them back), keep them, or leave
 * everything as it is. `/redo` asks the same about files edited after the
 * `/undo`, and says that overwriting those has no way back. What happened is not printed here; it arrives as the
 * session's own events (`history.reverted`, `history.restored`,
 * `revert.failed`) and the renderer shows it, as it would in a replay.
 *
 * How a command reaches the session: the input editor (`terminal.ts`) sees a
 * submitted `/undo` or `/redo` and runs it here, on the session `main.ts`
 * attached to the editor when it opened it (`Screen.attach`). An engine
 * whose sessions cannot revert attaches none, and the commands say so.
 */
import type { HandEditPolicy, RevertOptions, RevertPlan, RevertResult } from "@light-harness/core"
import type { SessionRevertOptions } from "./engine.ts"
import { type Segment, plural, seg } from "./text.ts"
import { fileList } from "./tools.ts"

/** What `/undo` and `/redo` need from a session: the engine's revert and its undo, which may ask about hand edits. */
export interface RevertableSession {
  revert(options?: SessionRevertOptions): Promise<RevertResult>
  undoRevert(options?: Omit<SessionRevertOptions, "messageId">): Promise<RevertResult>
}

/**
 * `handEdits: "ask"` for an engine whose revert only takes a policy: it is
 * tried with `abort`, and when that finds files edited by hand, the question
 * is put and the revert done again with the answer. The engine changes
 * nothing before it has looked for hand edits, so the first try leaves no
 * trace. An engine reached over the protocol asks the same through the
 * protocol instead.
 */
export async function askLocally(act: (options: RevertOptions) => Promise<RevertResult>, options: SessionRevertOptions): Promise<RevertResult> {
  const { confirm, handEdits, ...rest } = options
  if (handEdits !== "ask") return act({ ...rest, ...(handEdits === undefined ? {} : { handEdits }) })
  const first = await act({ ...rest, handEdits: "abort" })
  if (first.kind !== "hand_edited" || confirm === undefined) return first
  const answer = await confirm(first.plan)
  return answer === null ? first : act({ ...rest, handEdits: answer })
}

/** What a command needs from the terminal: lines of output, and an answer to a question. */
export interface CommandIo {
  print(line: readonly Segment[]): void
  /** Shows `question` as the prompt and resolves with what is submitted, or `null` when the user backs out (Ctrl-C, Ctrl-D). */
  ask(question: string): Promise<string | null>
}

const COMMANDS = ["/undo", "/redo"] as const
type Command = (typeof COMMANDS)[number]

/** The command a submitted entry is, or `null` when it is something to send to the agent. */
export function sessionCommand(entry: string): Command | null {
  const word = entry.trim()
  return COMMANDS.find((command) => command === word) ?? null
}

/** The session's revert and its undo, when it has both. */
export function revertable(session: Partial<RevertableSession>): RevertableSession | null {
  const { revert, undoRevert } = session
  if (revert === undefined || undoRevert === undefined) return null
  return { revert: (options) => revert.call(session, options), undoRevert: (options) => undoRevert.call(session, options) }
}

/** Runs `/undo` or `/redo` on `session` to its end: the preview, the question if there is one, the revert. Never throws. */
export async function runSessionCommand(command: Command, session: RevertableSession | null, io: CommandIo): Promise<void> {
  const undo = command === "/undo"
  const note = (text: string, tone: "dim" | "yellow" | "red" = "dim") => io.print([seg(text, tone)])
  if (session === null) return note(`${command} is not available with this engine`, "yellow")
  const act = (options: Omit<SessionRevertOptions, "messageId">) => (undo ? session.revert(options) : session.undoRevert(options))
  try {
    const preview = await act({ dryRun: true })
    if (preview.kind !== "preview") return note(refusal(command, preview), "yellow")
    const plan = preview.plan
    for (const line of describePlan(plan, undo)) io.print(line)
    const byHand = plan.changes.filter((change) => change.handEdited).map((change) => change.path)
    if (byHand.length === 0 && plan.target === null && undo) {
      // The conversation would go back and the files would not: that is worth a question too.
      const answer = (await io.ask("rewind the conversation without restoring files? [y/N] › "))?.trim().toLowerCase() ?? ""
      if (answer !== "y" && answer !== "yes") return note("  nothing was changed")
    }
    // The engine asks about files edited by hand when it finds them, which is right before it would overwrite them.
    let declined = false
    const confirm = async (asked: RevertPlan): Promise<HandEditPolicy | null> => {
      const edited = asked.changes.filter((change) => change.handEdited).map((change) => change.path)
      io.print([seg(`  you edited ${plural(edited.length, "file")} by hand since then: `, "yellow"), seg(fileList(edited, 6))])
      // Only an undo keeps a way back: /redo restores the workspace as it was right before it, hand edits included.
      io.print([seg(undo ? "  overwriting them is safe: /redo brings them back" : "  overwriting them cannot be taken back: /undo returns to before the turn, not to your edits", undo ? "dim" : "yellow")])
      const answer = (await io.ask("overwrite them? [y]es · [k]eep mine · [N]o › "))?.trim().toLowerCase() ?? ""
      if (answer === "y" || answer === "yes") return "overwrite"
      if (answer === "k" || answer === "keep") return "keep"
      declined = true
      return null
    }
    const result = await act({ handEdits: "ask", confirm })
    if (declined) return note("  nothing was changed")
    if (result.kind !== "reverted" && result.kind !== "failed") note(refusal(command, result), "yellow")
    // A failure is shown by the `revert.failed` event; one that never got that far is said here.
    if (result.kind === "failed" && result.plan === null) note(result.message, "red")
  } catch (error) {
    note(`${command} failed: ${error instanceof Error ? error.message : String(error)}`, "red")
  }
}

/** Why a command did nothing, as a line for the user. */
function refusal(command: Command, result: RevertResult): string {
  if (result.kind === "refused" && result.reason === "busy") return `${command} works only while the agent is idle; stop it first (Ctrl-C)`
  if (result.kind === "refused" && result.reason === "nothing_to_revert") return command === "/undo" ? "there is no turn to undo" : "there is nothing to redo"
  if (result.kind === "hand_edited") return "files were edited by hand in the meantime; nothing was changed"
  return `${command}: ${"message" in result ? result.message : "nothing was changed"}`
}

/** What the command is about to do, in a few lines. */
function describePlan(plan: RevertPlan, undo: boolean): Segment[][] {
  const lines: Segment[][] = []
  const what = undo ? "going back to before your last message" : "bringing back what the last /undo took away"
  lines.push([seg(`${undo ? "↶" : "↷"} `, "cyan"), seg(what), seg(` · ${plural(plan.messages, "message")}`, "dim")])
  if (plan.target === null) lines.push([seg(`  files are not restored: ${plan.unrestorable ?? "no snapshot"}`, "yellow")])
  else if (plan.changes.length === 0) lines.push([seg("  no file needs to change", "dim")])
  else {
    const describe = (status: string) => (status === "added" ? "restored" : status === "deleted" ? "removed" : "changed back")
    const groups = ["modified", "mode_changed", "type_changed", "added", "deleted"].flatMap((status) => {
      const paths = plan.changes.filter((change) => change.status === status).map((change) => change.path)
      return paths.length === 0 ? [] : [[seg(`  ${describe(status)}: `, "dim"), seg(fileList(paths, 6))]]
    })
    lines.push(...groups)
  }
  if (plan.kept.length > 0) lines.push([seg(`  left alone (ignored or never recorded): ${fileList(plan.kept.map((item) => item.path), 6)}`, "dim")])
  return lines
}

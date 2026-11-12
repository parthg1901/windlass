/**
 * What each point does with the hooks' answers, and the exact text the model is shown. Pure.
 *
 * The rules this file makes impossible to break, by the shape of its types:
 * - A before hook decides allow or refuse. There is no way to hand back other arguments: the call is already
 *   in the log and in the model's context, and runs with exactly the arguments it was recorded with. `allow`
 *   means "no objection"; it never approves a call the approval layer would ask about.
 * - An after hook may add a note. The result it is given is returned with the note appended after its text:
 *   the original text is always a prefix of the new one, and status, truncation, attachments and display are
 *   the tool's own. The note is added before the result is capped and stored, so it is stored and replayed
 *   with the result byte for byte.
 * - A stop hook may let the turn end or send the model back with a message, at most `maxStopRounds` times
 *   per turn. After that the turn ends, and says the hook was not satisfied. It never loops.
 *
 * Safe outcomes when a hook cannot answer (timed out, crashed, garbage, cannot run):
 * - before: the call is refused (fail closed), unless the hook says `onError: "allow"`. A before hook exists to
 *   enforce a rule ("never push"); a hook that silently stops answering must not quietly let through what it
 *   was there to stop. The model is told the call was not run and why, so it can tell the user.
 * - after: nothing is added (fail open). The result is the tool's own; a missing note is never worse than no hook.
 * - stop: the turn may end (fail open). The model cannot fix a hook that crashes, so sending it back would only
 *   spend rounds; the turn's ending records the failure and the user is told.
 * In every case the user is told (`HookRecord.failure`).
 */
import type { Message } from "../message/message.ts"
import type { ToolResult } from "../tool/tool.ts"
import type { HookAnswer } from "./answer.ts"
import type { Hook } from "./config.ts"

export interface HookVerdict {
  readonly hook: Hook
  readonly answer: HookAnswer
}

// ---------------------------------------------------------------------------------------------------------------
// before

export type BeforeDecision =
  | { readonly kind: "allow" }
  /** `output` is the error result of the call, frozen in `tool.settled` as the model's view of it. */
  | { readonly kind: "refuse"; readonly hook: Hook; readonly because: "refused" | "failed"; readonly output: string }
  /** The execution is being interrupted: the call is not started. */
  | { readonly kind: "interrupted" }

/** What one before hook's answer means for the call: go on to the next hook, or the decision. */
export function beforeVerdict(verdict: HookVerdict): BeforeDecision {
  const { hook, answer } = verdict
  switch (answer.kind) {
    case "yes":
      return { kind: "allow" }
    case "interrupted":
      return { kind: "interrupted" }
    case "no":
      return { kind: "refuse", hook, because: "refused", output: refusalText(hook, answer.text) }
    case "failed":
      if (hook.onError === "allow") return { kind: "allow" }
      return { kind: "refuse", hook, because: "failed", output: failedRefusalText(hook, answer.detail) }
  }
}

/** The decision for a call from the verdicts of its hooks in order: the first that does not allow decides. */
export function decideBefore(verdicts: readonly HookVerdict[]): BeforeDecision {
  for (const verdict of verdicts) {
    const decision = beforeVerdict(verdict)
    if (decision.kind !== "allow") return decision
  }
  return { kind: "allow" }
}

export function refusalText(hook: Hook, reason: string): string {
  return reason === ""
    ? `This call was not run: the hook "${hook.name}" refused it and gave no reason.`
    : `This call was not run: the hook "${hook.name}" refused it.\n${reason}`
}

export function failedRefusalText(hook: Hook, detail: string): string {
  const whose = hook.origin === "user" ? "the user's configuration" : "this project's configuration"
  return `This call was not run: the hook "${hook.name}" (from ${whose}) must allow it and could not answer: ${detail}. Do not try to work around the hook; tell the user it is failing.`
}

// ---------------------------------------------------------------------------------------------------------------
// after

/** The most text all notes on one result may add together. */
export const MAX_NOTES_CHARS = 4000

export interface AppliedNotes {
  /** The tool's result with the notes appended; `result.output` is a prefix of `output`. */
  readonly result: ToolResult
  /** The hooks whose notes were appended, in order. */
  readonly noted: readonly Hook[]
  /** Hooks whose notes did not fit within `MAX_NOTES_CHARS`. */
  readonly dropped: readonly Hook[]
}

/**
 * Appends the notes of after hooks to a tool's result. Nothing of the result is changed or removed: a hook can
 * only add text after it. A failed or interrupted hook adds nothing.
 */
export function applyAfterNotes(result: ToolResult, verdicts: readonly HookVerdict[]): AppliedNotes {
  const noted: Hook[] = []
  const dropped: Hook[] = []
  let suffix = ""
  for (const { hook, answer } of verdicts) {
    if (answer.kind !== "no" || answer.text === "") continue
    const block = noteText(hook, answer.text)
    if (suffix.length + block.length > MAX_NOTES_CHARS) {
      dropped.push(hook)
      continue
    }
    suffix += block
    noted.push(hook)
  }
  if (suffix === "") return { result, noted, dropped }
  return { result: { ...result, output: `${result.output}${suffix}` }, noted, dropped }
}

export function noteText(hook: Hook, note: string): string {
  return `\n\n[Note from the hook "${hook.name}"]\n${note}`
}

// ---------------------------------------------------------------------------------------------------------------
// stop

/**
 * The origin of the harness message a stop hook sends the model back with. The engine pass adds it to
 * `HARNESS_ORIGIN` in `event/durable.ts` (`stopHook: "stop_hook"`).
 */
export const STOP_HOOK_ORIGIN = "stop_hook"

/**
 * How many times stop hooks sent the model back in a turn: the stop-hook messages among the turn's messages
 * (`wholeTurn(projection)` in `engine/state.ts`: since the user's message or the queued item that began it, not
 * since a message the harness delivered in the middle), never a counter in memory, so a restart counts the same.
 */
export function stopRoundsSent(turn: readonly Message[]): number {
  return turn.filter((message) => message.kind === "synthetic" && message.delivery === null && message.origin === STOP_HOOK_ORIGIN && message.excluded === null).length
}

export interface StopInput {
  readonly verdicts: readonly HookVerdict[]
  /** How many times stop hooks already sent the model back in this turn, counted from the log. */
  readonly roundsSent: number
  readonly maxRounds: number
}

export type StopDecision =
  /** The turn may end. `failed`: hooks that could not answer, for the user. */
  | { readonly kind: "end"; readonly failed: readonly Hook[] }
  /** Append `message` (frozen) as a harness message and continue the turn. */
  | { readonly kind: "continue"; readonly hooks: readonly Hook[]; readonly message: string; readonly round: number }
  /**
   * The bound was reached and these hooks still object: the turn ends and says so. `notice` is for the user.
   * `objections` is what each of them said this last time, in the order they ran (the text is empty for a hook
   * that gave no reason): nobody is sent back with it, so it is the ending's to carry.
   */
  | { readonly kind: "end_unsatisfied"; readonly hooks: readonly Hook[]; readonly objections: readonly { readonly hook: Hook; readonly text: string }[]; readonly failed: readonly Hook[]; readonly notice: string }
  | { readonly kind: "interrupted" }

export function decideStop(input: StopInput): StopDecision {
  if (input.verdicts.some((verdict) => verdict.answer.kind === "interrupted")) return { kind: "interrupted" }
  const objecting = input.verdicts.filter((verdict) => verdict.answer.kind === "no")
  const failed = input.verdicts.filter((verdict) => verdict.answer.kind === "failed").map((verdict) => verdict.hook)
  if (objecting.length === 0) return { kind: "end", failed }
  const hooks = objecting.map((verdict) => verdict.hook)
  if (input.roundsSent >= input.maxRounds)
    return {
      kind: "end_unsatisfied",
      hooks,
      objections: objecting.map(({ hook, answer }) => ({ hook, text: answer.kind === "no" ? answer.text : "" })),
      failed,
      notice: `The turn ended although ${hooks.length === 1 ? "the stop hook" : "the stop hooks"} ${hooks.map((hook) => `"${hook.name}"`).join(", ")} still objected: the agent was sent back ${input.maxRounds} ${input.maxRounds === 1 ? "time" : "times"} already, the most a turn allows.`,
    }
  const round = input.roundsSent + 1
  return { kind: "continue", hooks, round, message: stopMessage(objecting, round, input.maxRounds) }
}

function stopMessage(objecting: readonly HookVerdict[], round: number, maxRounds: number): string {
  const parts = objecting.map(({ hook, answer }) => {
    const text = answer.kind === "no" ? answer.text : ""
    return text === "" ? `The hook "${hook.name}" did not let the turn end and gave no reason.` : `The hook "${hook.name}" says:\n${text}`
  })
  const last = round === maxRounds ? " This is the last time: if you stop again, the turn ends with the hook unsatisfied." : ""
  return `[Stop hook ${round} of at most ${maxRounds}] The turn cannot end yet.${last}\n\n${parts.join("\n\n")}`
}

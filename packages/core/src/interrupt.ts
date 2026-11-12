/**
 * One abort token per execution, with an explicit reason and no default
 * (cancel rule 2). The reason decides whether the crash-recovery claim is
 * released, so a missing reason must be a compile error, never a guess.
 */
import { type Infer, oneOf } from "./validate.ts"

/**
 * Why an execution was interrupted.
 * - `user`: the user cancelled. The claim is released; the session goes idle.
 * - `shutdown`: the process is exiting. The claim is kept so the next start resumes the session.
 *
 * Adding a value later is backwards compatible for stored events, but every
 * exhaustive switch (such as `releasesClaim`) will then fail to compile until it handles it.
 */
export const interruptReason = oneOf(["user", "shutdown"])
export type InterruptReason = Infer<typeof interruptReason>

/** Whether an interruption for this reason ends the execution's crash-recovery claim. */
export function releasesClaim(reason: InterruptReason): boolean {
  switch (reason) {
    case "user":
      return true
    case "shutdown":
      return false
  }
}

/** The value of `signal.reason` on every signal created by `createInterrupt`. */
export class Interrupted extends Error {
  constructor(readonly reason: InterruptReason) {
    super(`interrupted: ${reason}`)
    this.name = "Interrupted"
  }
}

export interface Interrupt {
  readonly signal: AbortSignal
  /** Aborts the signal. The first call wins; later calls are ignored. */
  readonly interrupt: (reason: InterruptReason) => void
}

/** Creates the abort token for one execution. */
export function createInterrupt(): Interrupt {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    interrupt: (reason) => controller.abort(new Interrupted(reason)),
  }
}

/**
 * Reads the reason from a signal. Returns `null` when the signal is not
 * aborted. Throws when it was aborted by something other than `createInterrupt`,
 * because an abort without a reason is exactly the bug this module exists to prevent.
 */
export function interruptReasonOf(signal: AbortSignal): InterruptReason | null {
  if (!signal.aborted) return null
  if (signal.reason instanceof Interrupted) return signal.reason.reason
  throw new Error("signal was aborted without an InterruptReason; abort only through createInterrupt()", {
    cause: signal.reason,
  })
}

/**
 * The value of `signal.reason` on the signal of one tool call that the user
 * stopped by itself (`createCallStop`). The execution is not interrupted:
 * the step carries on with its other calls, and the model reads this call's
 * result like any other.
 */
export class CallCancelled extends Error {
  constructor() {
    super("the user stopped this tool call")
    this.name = "CallCancelled"
  }
}

/**
 * Why a tool call is being stopped: the execution was interrupted (`user`,
 * `shutdown`), or the user stopped this one call and nothing else (`call`).
 * Never stored: an execution's interruption is an `InterruptReason`, and a
 * stopped call is recorded as `tool.cancel_requested`.
 */
export type CallStopReason = InterruptReason | "call"

export interface CallStop {
  /** What the tool is given: aborted when the execution is interrupted, or when this call alone is stopped. */
  readonly signal: AbortSignal
  /** Stops this call and nothing else. A no-op once the signal is aborted, for whatever reason. */
  readonly cancel: () => void
  /** Stops listening to the execution's signal, once the call is over. */
  readonly release: () => void
}

/**
 * The abort token of one tool call: it follows the execution's signal, with
 * the execution's reason, and can also be aborted by itself. The first
 * abort wins.
 */
export function createCallStop(execution: AbortSignal): CallStop {
  const controller = new AbortController()
  const follow = () => controller.abort(execution.reason)
  if (execution.aborted) follow()
  else execution.addEventListener("abort", follow, { once: true })
  return {
    signal: controller.signal,
    cancel: () => controller.abort(new CallCancelled()),
    release: () => execution.removeEventListener("abort", follow),
  }
}

/**
 * Reads the reason from the signal a tool call was given (`ToolContext.signal`).
 * Returns `null` when it is not aborted. Throws, like `interruptReasonOf`,
 * when it was aborted without a reason.
 */
export function callStopReasonOf(signal: AbortSignal): CallStopReason | null {
  if (signal.aborted && signal.reason instanceof CallCancelled) return "call"
  return interruptReasonOf(signal)
}

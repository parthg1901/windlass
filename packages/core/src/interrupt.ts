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

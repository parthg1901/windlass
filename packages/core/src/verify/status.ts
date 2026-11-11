/**
 * How one check ended. Declared apart from the code that runs checks, so the
 * durable event schema can name a check's status without importing the shell tool.
 */
import { type Infer, oneOf } from "../validate.ts"

export const checkStatus = oneOf(["passed", "failed", "timed_out", "could_not_start", "interrupted"])
export type CheckStatus = Infer<typeof checkStatus>

/** A status that means the check did not pass. `interrupted` is not one: the check did not finish. */
export function isFailure(status: CheckStatus): boolean {
  return status === "failed" || status === "timed_out" || status === "could_not_start"
}

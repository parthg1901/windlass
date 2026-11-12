// The service's time comes from now() in src/lib/clock.ts, which tests move with setNow() (clock.ts, CONTRIBUTING.md,
// sessions.ts and invites.ts); resets.ts is older and calls Date.now(). Graded on behaviour under the project's own
// clock: with the clock moved, a link 29 minutes old still works and one 31 minutes old (or older) does not, whether
// expiry throws or returns no user. A check that reads the system clock does not see the moved clock and fails.
// The clock starts at the real time, so a createdAt still taken from Date.now() is not held against the change.
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/resets.test.ts", "src/sessions.test.ts"])
const clock = await importFrom<{ setNow: (ms: number | null) => void }>(workspace, "src/lib/clock.ts")
const resets = await importFrom<{ createReset: (userId: string) => { token: string }; useReset: (token: string) => string | null | undefined | false }>(workspace, "src/resets.ts")
const MINUTE = 60_000

function attempt(token: string): string | null {
  try {
    const user = resets.useReset(token)
    return typeof user === "string" ? user : null
  } catch {
    return null
  }
}

const start = Date.now()
clock.setNow(start)
const fresh = resets.createReset("usr_fresh")
clock.setNow(start + 29 * MINUTE)
if (attempt(fresh.token) !== "usr_fresh") fail("a reset link 29 minutes old no longer works (with the clock moved by setNow)")
for (const age of [31, 45, 24 * 60]) {
  clock.setNow(start)
  const old = resets.createReset(`usr_${age}`)
  clock.setNow(start + age * MINUTE)
  if (attempt(old.token) !== null) fail(`a reset link ${age} minutes old still works when the clock is moved with setNow(); the expiry must read the project's clock (now() in src/lib/clock.ts)`)
}
clock.setNow(null)
const now = resets.createReset("usr_now")
if (attempt(now.token) !== "usr_now") fail("a new reset link does not work on the real clock")
pass("reset links expire after 30 minutes, measured on the project's clock")

/**
 * Waiting in tests for the state a test means, not for an amount of time.
 *
 * A fixed sleep ("give it 300 ms") passes on a quiet machine and fails on a loaded
 * CI runner, where a process start or a write can take several times longer. A
 * test instead waits for what it is about to depend on (a line printed, an event
 * stored, a file written, a process gone) and fails with a message that says what
 * never happened. The deadline is generous because it only matters when something
 * is wrong; a test that passes never waits for it.
 */

export interface WaitOptions {
  /** How long to wait before failing, in milliseconds. Default 10 s. */
  readonly timeoutMs?: number
  /** How often to check, in milliseconds. Default 10. */
  readonly intervalMs?: number
  /** What is being waited for, for the failure message ("the server to be ready"). */
  readonly what?: string
  /** Called on failure to describe the state that was reached instead (output so far, events seen). */
  readonly describe?: () => string
}

/** The default deadline: long enough for a loaded runner, short enough that a hang still fails inside a test's limit. */
export const WAIT_TIMEOUT_MS = 10_000

/**
 * The time limit for each test in an end-to-end file (`*.e2e.test.ts`), set with `setDefaultTimeout`: such a test
 * starts real processes (git, shells, servers, the program itself), each of which can take most of a second to start
 * on a shared CI runner. Unit tests keep the runner's 5 s, so that a hang there shows quickly.
 */
export const E2E_TIMEOUT_MS = 30_000

/**
 * Resolves with the first truthy value `check` returns, checking every
 * `intervalMs`; rejects after `timeoutMs` saying what was awaited. `check` may
 * be async. An error thrown by `check` fails the wait at once.
 */
export async function waitFor<T>(check: () => T | Promise<T>, options: WaitOptions = {}): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 10
  const started = performance.now()
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    const waited = performance.now() - started
    if (waited > timeoutMs) {
      const state = options.describe === undefined ? "" : `\n${options.describe()}`
      throw new Error(`timed out after ${Math.round(waited)} ms waiting for ${options.what ?? "a condition"}${state}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Resolves once `promise` settles, or rejects after `timeoutMs` saying what was awaited. */
export async function within<T>(promise: Promise<T>, timeoutMs: number, what = "a promise"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the process `pid` still exists (a zombie counts as gone where the platform can tell). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

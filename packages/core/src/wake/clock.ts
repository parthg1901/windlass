/**
 * The clock every time-related part of the wake module takes, so tests move time instead of sleeping.
 * `sleep` resolves after `ms` or as soon as `signal` aborts, whichever is first; it never rejects.
 */
export interface WakeClock {
  /** Milliseconds since the epoch. */
  readonly now: () => number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The real clock: `Date.now()` and one `setTimeout` per sleep. */
export const systemClock: WakeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      // setTimeout takes at most 2^31-1 ms; callers sleep far less than that.
      const timer = setTimeout(done, Math.max(0, Math.min(ms, 2_147_483_647)))
      signal?.addEventListener("abort", done, { once: true })
    }),
}

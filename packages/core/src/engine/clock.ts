/**
 * The loop's clock: everything it waits for (a retry delay, the grace period
 * of a stopping tool) goes through `sleep`, so a test drives time by hand.
 * Event timestamps are the store's own clock, not this one.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted || ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener("abort", done, { once: true })
    })
  },
}

/** Resolves when `signal` aborts (at once if it already has). Never rejects. */
export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

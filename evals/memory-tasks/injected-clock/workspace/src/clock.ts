// The service's clock. Everything that needs the current time calls now(); tests freeze or move it with setNow().

let frozen: number | null = null

/** Milliseconds since the epoch: the frozen time in tests, the system clock otherwise. */
export function now(): number {
  return frozen ?? Date.now()
}

/** Freezes the clock at `ms`, or unfreezes it with `null`. For tests. */
export function setNow(ms: number | null): void {
  frozen = ms
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

// What the service needs from its surroundings, in one place so tests can replace it: the current time, random
// tokens and the log. Tests freeze or move the time with setNow().

let frozen: number | null = null

/** Milliseconds since the epoch: the frozen time in tests, the system clock otherwise. */
export function now(): number {
  return frozen ?? Date.now()
}

/** Freezes the time at `ms`, or unfreezes it with `null`. For tests. */
export function setNow(ms: number | null): void {
  frozen = ms
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** A random, URL-safe token. */
export function randomToken(bytes = 16): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
}

export const logLines: string[] = []

export function log(line: string): void {
  logLines.push(line)
}

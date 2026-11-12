/** A response timestamp: ISO 8601 in UTC (decision 7). */
export function iso(date: Date): string
export function iso(date: Date | null): string | null
export function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString()
}

/** Unix seconds, for the v2 webhook payloads only (decision 7). */
export function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

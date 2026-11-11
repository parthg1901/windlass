/** Formats a duration in milliseconds as a compact human string, e.g. 3723000 -> "1h 2m 3s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`invalid duration: ${ms}`)
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(" ")
}

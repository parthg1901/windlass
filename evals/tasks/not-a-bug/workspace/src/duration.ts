// Durations as people write them in config files: "90s", "15m", "1h30m", "2d". Results are whole seconds.

const UNIT_SECONDS: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 }
const PART = /(\d+)\s*([dhms])/g

export function parseDuration(text: string): number {
  const input = text.trim().toLowerCase()
  if (input === "") throw new SyntaxError("empty duration")
  // A bare number is seconds, as in 1.x.
  if (/^\d+$/.test(input)) return Number(input)
  let seconds = 0
  let consumed = 0
  for (const match of input.matchAll(PART)) {
    seconds += Number(match[1]) * UNIT_SECONDS[match[2]!]!
    consumed += match[0].length
  }
  if (consumed !== input.replace(/\s+/g, "").length && consumed !== input.length) throw new SyntaxError(`not a duration: ${text}`)
  return seconds
}

export function formatDuration(seconds: number): string {
  const parts: string[] = []
  let rest = Math.round(seconds)
  for (const [unit, size] of Object.entries(UNIT_SECONDS)) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${unit}`)
      rest %= size
    }
  }
  return parts.join("") || "0s"
}

/** "the quick fox" -> "The Quick Fox". Words are separated by whitespace, which is collapsed to one space. */
export function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

/** Cuts `text` to at most `max` characters, ending with "…" when it was cut. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

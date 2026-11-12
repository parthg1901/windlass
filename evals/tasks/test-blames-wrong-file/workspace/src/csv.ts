export interface Row {
  readonly date: string
  readonly description: string
  /** Integer cents; negative for money going out. */
  readonly amount: number
}

/** The fields of one line of the bank's CSV export. */
export function splitLine(line: string): string[] {
  return line.split(",").map((field) => field.trim())
}

/** "12.50" -> 1250 */
export function parseAmount(text: string): number {
  return Math.round(Number.parseFloat(text) * 100)
}

/** A whole export: a header line `date,description,amount`, then one row per line. */
export function parseStatement(text: string): Row[] {
  const [, ...lines] = text.split("\n").filter((line) => line.trim() !== "")
  return lines.map((line) => {
    const [date = "", description = "", amount = ""] = splitLine(line)
    return { date, description, amount: parseAmount(amount) }
  })
}

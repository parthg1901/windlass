import type { Row } from "./csv.ts"
import { formatMoney } from "./money.ts"

export function totalsLine(rows: readonly Row[]): string {
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  return `Total: ${formatMoney(total)} (${rows.length} transactions)`
}

export function largest(rows: readonly Row[]): Row | undefined {
  return [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]
}

import { formatMoney } from "./util/money.ts"

export interface Sale {
  readonly region: string
  readonly amount: number
}

/** The finance report is in euros and German formatting, whatever the customer used. */
export function regionReport(sales: readonly Sale[]): string[] {
  const totals = new Map<string, number>()
  for (const sale of sales) totals.set(sale.region, (totals.get(sale.region) ?? 0) + sale.amount)
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([region, total]) => `${region}: ${formatMoney(total, "EUR", "de-DE")}`)
}

import type { Customer } from "./types.ts"
import { formatMoney } from "./util/money.ts"

export function receipt(customer: Customer, paid: number, change: number): string {
  const lines = [`Paid ${formatMoney(paid, customer.currency, customer.locale)}`]
  if (change > 0) lines.push(`Change ${formatMoney(change, customer.currency, customer.locale)}`)
  return lines.join("\n")
}

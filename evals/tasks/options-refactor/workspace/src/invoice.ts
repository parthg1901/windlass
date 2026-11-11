import type { Customer, Item } from "./types.ts"
import { formatMoney } from "./util/money.ts"

export function invoiceLines(customer: Customer, items: readonly Item[]): string[] {
  return items.map((item) => `${item.quantity} x ${item.label}: ${formatMoney(item.price * item.quantity, customer.currency, customer.locale)}`)
}

export function invoiceTotal(customer: Customer, items: readonly Item[]): string {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  return `Total: ${formatMoney(total, customer.currency, customer.locale)}`
}

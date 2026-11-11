import type { Customer, Item } from "./types.ts"
import { invoiceLines, invoiceTotal } from "./invoice.ts"
import { formatMoney } from "./util/money.ts"

export function invoiceEmail(customer: Customer, items: readonly Item[], due: number): string {
  return [
    `Hello ${customer.name},`,
    "",
    ...invoiceLines(customer, items),
    invoiceTotal(customer, items),
    "",
    `Please pay ${formatMoney(due, customer.currency, customer.locale)} within 14 days.`,
  ].join("\n")
}

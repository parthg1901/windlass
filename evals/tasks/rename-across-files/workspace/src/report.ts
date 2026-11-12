import { total, totalByUser } from "./invoices.ts"
import type { Invoice } from "./types.ts"

function cents(amount: number) {
  return (amount / 100).toFixed(2)
}

/** One line per invoice: id, user, total. */
export function invoiceLine(invoice: Invoice): string {
  return `${invoice.id}  ${invoice.userId.padEnd(10)}  ${cents(total(invoice)).padStart(9)}${invoice.paid ? "" : "  unpaid"}`
}

export function monthlyReport(invoices: readonly Invoice[]): string {
  const byUser = totalByUser(invoices)
  const users = Object.keys(byUser).sort()
  return [...invoices.map(invoiceLine), "", ...users.map((user) => `${user.padEnd(10)}  ${cents(byUser[user]!).padStart(9)}`)].join("\n")
}

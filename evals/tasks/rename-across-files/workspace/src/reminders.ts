import { total } from "./invoices.ts"
import type { Invoice } from "./types.ts"

export interface Reminder {
  readonly to: string
  readonly invoices: readonly string[]
  readonly owed: number
}

/** One reminder per user with unpaid invoices issued before `before` (YYYY-MM-DD), largest debt first. */
export function remindersDue(invoices: readonly Invoice[], before: string): Reminder[] {
  const grouped = new Map<string, Invoice[]>()
  for (const invoice of invoices) {
    if (invoice.paid || invoice.issuedAt >= before) continue
    const list = grouped.get(invoice.userId) ?? []
    list.push(invoice)
    grouped.set(invoice.userId, list)
  }
  return [...grouped.entries()]
    .map(([to, list]) => ({ to, invoices: list.map((invoice) => invoice.id), owed: list.reduce((sum, invoice) => sum + total(invoice), 0) }))
    .sort((a, b) => b.owed - a.owed || a.to.localeCompare(b.to))
}

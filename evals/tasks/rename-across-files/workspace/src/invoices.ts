import type { Invoice, Line } from "./types.ts"

let counter = 0

export function createInvoice(userId: string, lines: readonly Line[], issuedAt = "2026-01-01"): Invoice {
  counter += 1
  return { id: `inv_${String(counter).padStart(4, "0")}`, userId, issuedAt, paid: false, lines: [...lines] }
}

export function total(invoice: Invoice): number {
  return invoice.lines.reduce((sum, line) => sum + line.amount, 0)
}

export function invoicesFor(invoices: readonly Invoice[], userId: string): Invoice[] {
  return invoices.filter((invoice) => invoice.userId === userId)
}

/** Total billed per user, in cents. */
export function totalByUser(invoices: readonly Invoice[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const invoice of invoices) totals[invoice.userId] = (totals[invoice.userId] ?? 0) + total(invoice)
  return totals
}

export function markPaid(invoice: Invoice): Invoice {
  return { ...invoice, paid: true }
}

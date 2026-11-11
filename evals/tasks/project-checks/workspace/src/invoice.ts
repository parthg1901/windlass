import { bulkDiscount } from "./discount.ts"

export interface Line {
  readonly label: string
  readonly amount: number
}

export interface Invoice {
  readonly lines: readonly Line[]
  readonly total: number
}

/** An invoice for some items: one line per item, a discount line when the bulk discount applies, and the total. */
export function invoice(items: readonly Line[]): Invoice {
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  const discount = bulkDiscount(subtotal)
  const lines = [...items]
  if (subtotal > 100) lines.push({ label: "Bulk discount (10%)", amount: -discount })
  return { lines, total: Math.round((subtotal - discount) * 100) / 100 }
}

import type { LineItem } from "./types.ts"

/** What the shop sells; `unitPrice` is what one costs. */
export const CATALOG = {
  "mug-classic": { name: "Classic mug", unitPrice: 1299 },
  "mug-travel": { name: "Travel mug", unitPrice: 2499 },
  "beans-500g": { name: "House beans, 500 g", unitPrice: 1650 },
  "filter-papers": { name: "Filter papers (100)", unitPrice: 399 },
} as const

export type Sku = keyof typeof CATALOG

export function lineItem(sku: Sku, quantity: number): LineItem {
  return { sku, quantity, unitPrice: CATALOG[sku].unitPrice }
}

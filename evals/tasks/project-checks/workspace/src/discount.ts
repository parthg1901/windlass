export const BULK_THRESHOLD = 100
export const BULK_RATE = 0.1

/** The bulk discount for an order subtotal, in the same currency units, rounded to cents. */
export function bulkDiscount(subtotal: number): number {
  if (subtotal > BULK_THRESHOLD) return Math.round(subtotal * BULK_RATE * 100) / 100
  return 0
}

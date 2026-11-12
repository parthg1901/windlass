/** Amounts are cents; this is how a page shows one. */
export function displayMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

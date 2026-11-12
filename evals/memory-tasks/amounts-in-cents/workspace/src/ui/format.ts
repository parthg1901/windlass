// Display helpers. Every price, subtotal, fee and total in this codebase is an integer number of cents (1999 is
// $19.99); this is the only place that turns them into dollars.

export function dollars(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`
}

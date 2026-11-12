export function dollars(amount: number): string {
  return `$${(amount / 100).toFixed(2)}`
}

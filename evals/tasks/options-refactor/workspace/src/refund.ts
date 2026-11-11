import type { Customer } from "./types.ts"
import { formatMoney } from "./util/money.ts"

/** Refunds are always shown in US English for the support team, in the customer's currency. */
export function refundNote(customer: Customer, amount: number, reason: string): string {
  return `Refund of ${formatMoney(amount, customer.currency, "en-US")} to ${customer.name}: ${reason}`
}

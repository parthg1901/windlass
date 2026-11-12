import { AppError } from "./errors/app-error.ts"

const SUPPORTED = new Set(["USD", "EUR", "GBP"])

function luhn(digits: string): boolean {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

export function charge(card: { number: string; expires: string }, amount: number, currency: string, today = "2026-11-12") {
  const digits = card.number.replace(/\s+/g, "")
  if (!/^\d{12,19}$/.test(digits) || !luhn(digits)) throw new AppError("E4004")
  if (card.expires < today.slice(0, 7)) throw new AppError("E4005", card.expires)
  if (!(amount > 0)) throw new AppError("E4006", String(amount))
  if (!SUPPORTED.has(currency)) throw new AppError("E4007", currency)
  return { charged: amount, currency, last4: digits.slice(-4) }
}

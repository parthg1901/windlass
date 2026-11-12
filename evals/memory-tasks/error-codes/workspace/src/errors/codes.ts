// The codes clients match on. Keep this list and the table in docs/errors.md in step: clients and support read the
// table, not this file.
export const CODES = {
  E4001: "an order needs at least one item",
  E4002: "quantity must be a positive whole number",
  E4003: "unknown product",
  E4004: "card number is not valid",
  E4005: "card has expired",
  E4006: "amount must be positive",
  E4007: "currency is not supported",
  E4008: "email address is already registered",
  E5001: "payment provider unavailable",
  E5002: "storage unavailable",
} as const

export type ErrorCode = keyof typeof CODES

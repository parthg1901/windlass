import { AppError } from "./errors/app-error.ts"

export interface OrderLine {
  readonly product: string
  readonly quantity: number
}

const CATALOGUE = new Set(["mug", "shirt", "poster"])

export function createOrder(customer: string, lines: readonly OrderLine[]) {
  if (lines.length === 0) throw new AppError("E4001")
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new AppError("E4002", `${line.product}: ${line.quantity}`)
    if (!CATALOGUE.has(line.product)) throw new AppError("E4003", line.product)
  }
  return { customer, lines: [...lines], status: "open" as const }
}

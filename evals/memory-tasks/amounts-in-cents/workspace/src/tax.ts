import type { Order } from "./types.ts"

/** Sales tax by region; Canada's is the combined federal and provincial rate the finance team picked for launch. */
export const TAX_RATE: Record<Order["region"], number> = { US: 0.07, CA: 0.13 }

export function taxFor(amount: number, region: Order["region"]): number {
  return Math.round(amount * TAX_RATE[region])
}

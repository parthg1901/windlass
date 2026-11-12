import type { Order } from "../models.ts"
import { iso } from "./time.ts"

export function orderResponse(order: Order) {
  return { id: order.id, customerId: order.customerId, placedAt: iso(order.placedAt), items: order.items.map((item) => ({ ...item })) }
}

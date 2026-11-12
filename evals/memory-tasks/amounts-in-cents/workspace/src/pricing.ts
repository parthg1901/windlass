import { taxFor } from "./tax.ts"
import type { Coupon, Order } from "./types.ts"

export function subtotalOf(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
}

export function discount(order: Order, coupon: Coupon | null): number {
  if (coupon === null || order.couponCode !== coupon.code || order.subtotal < coupon.minimumSubtotal) return 0
  return (order.subtotal * coupon.percentOff) / 100
}

export function tax(order: Order, coupon: Coupon | null): number {
  return taxFor(order.subtotal - discount(order, coupon), order.region)
}

export function orderTotal(order: Order, coupon: Coupon | null = null): number {
  return order.subtotal - discount(order, coupon) + tax(order, coupon)
}

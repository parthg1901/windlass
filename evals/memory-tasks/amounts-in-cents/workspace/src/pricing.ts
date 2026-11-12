import type { Coupon, Order } from "./types.ts"

const TAX_RATE: Record<Order["region"], number> = { US: 0.07, CA: 0.13 }

export function subtotalOf(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
}

export function discount(order: Order, coupon: Coupon | null): number {
  if (coupon === null || order.couponCode !== coupon.code || order.subtotal < coupon.minimumSubtotal) return 0
  return Math.round((order.subtotal * coupon.percentOff) / 100)
}

export function tax(order: Order, coupon: Coupon | null): number {
  return Math.round((order.subtotal - discount(order, coupon)) * TAX_RATE[order.region])
}

export function orderTotal(order: Order, coupon: Coupon | null = null): number {
  return order.subtotal - discount(order, coupon) + tax(order, coupon)
}

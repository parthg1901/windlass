import { discount, orderTotal, tax } from "../pricing.ts"
import type { Coupon, Order, Receipt } from "../types.ts"
import { dollars } from "./format.ts"

export function receipt(order: Order, coupon: Coupon | null = null): Receipt {
  const lines = [
    ...order.items.map((item) => `${item.quantity} x ${item.sku}  ${dollars(item.quantity * item.unitPrice)}`),
    `Subtotal  ${dollars(order.subtotal)}`,
    ...(discount(order, coupon) > 0 ? [`Discount  -${dollars(discount(order, coupon))}`] : []),
    `Tax  ${dollars(tax(order, coupon))}`,
  ]
  const total = orderTotal(order, coupon)
  return { orderId: order.id, lines: [...lines, `Total  ${dollars(total)}`], total }
}

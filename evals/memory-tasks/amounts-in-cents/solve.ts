import { join } from "node:path"

const path = join(process.argv[2]!, "src/pricing.ts")
const text = await Bun.file(path).text()
await Bun.write(
  path,
  text
    .replace("export function orderTotal", 'const FREE_SHIPPING_FROM = 5000\nconst SHIPPING = 499\n\nexport function shippingFee(order: Pick<Order, "subtotal">): number {\n  return order.subtotal < FREE_SHIPPING_FROM ? SHIPPING : 0\n}\n\nexport function orderTotal')
    .replace("return order.subtotal - discount(order, coupon) + tax(order, coupon)", "return order.subtotal - discount(order, coupon) + tax(order, coupon) + shippingFee(order)"),
)

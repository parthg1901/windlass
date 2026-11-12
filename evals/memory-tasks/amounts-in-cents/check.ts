// Every amount is integer cents (said at the end of src/types.ts, and visible in the tests). shippingFee must charge
// 499 below 5000 and nothing from 5000, and orderTotal must include it. Whether shipping is taxed is left open: the
// total may be either subtotal + tax + fee or subtotal + tax on (subtotal + fee) + fee.
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/pricing.test.ts"])
type Order = { id: string; items: []; subtotal: number; couponCode: null; region: "US" | "CA" }
const pricing = await importFrom<{ shippingFee?: (order: Order) => number; orderTotal: (order: Order, coupon?: null) => number }>(workspace, "src/pricing.ts")
if (typeof pricing.shippingFee !== "function") fail("src/pricing.ts does not export shippingFee")
const order = (subtotal: number): Order => ({ id: "o", items: [], subtotal, couponCode: null, region: "US" })
for (const [subtotal, fee] of [[1, 499], [2500, 499], [4999, 499], [5000, 0], [5001, 0], [12000, 0]] as const) {
  const got = pricing.shippingFee(order(subtotal))
  if (got !== fee) fail(`shippingFee for a subtotal of ${subtotal} cents is ${got}, expected ${fee} (amounts are integer cents)`)
}
for (const subtotal of [2500, 4999, 5000, 12000]) {
  const fee = subtotal < 5000 ? 499 : 0
  const untaxed = subtotal + Math.round(subtotal * 0.07) + fee
  const taxed = subtotal + Math.round((subtotal + fee) * 0.07) + fee
  const total = pricing.orderTotal(order(subtotal))
  if (total !== untaxed && total !== taxed) fail(`orderTotal for ${subtotal} cents is ${total}, expected ${untaxed} (shipping ${fee} added)`)
}
pass("shipping is 499 cents under 5000 and free from 5000, and the total includes it")

import type { Item } from "./types.ts"
import { formatMoney } from "./util/money.ts"

/** The storefront cart badge, always in the shop's own currency and locale. */
export function cartBadge(items: readonly Item[]): string {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const count = items.reduce((sum, item) => sum + item.quantity, 0)
  return `${count} item${count === 1 ? "" : "s"} · ${formatMoney(total, "USD", "en-US")}`
}

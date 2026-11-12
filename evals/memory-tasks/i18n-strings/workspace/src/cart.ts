import { t } from "./i18n/t.ts"
import { displayMoney } from "./money.ts"

export interface CartItem {
  readonly name: string
  readonly quantity: number
  readonly unitPrice: number
}

/** The lines of the cart page. */
export function cartLines(items: readonly CartItem[]): string[] {
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const lines = [t("cart.heading")]
  for (const item of items) lines.push(`${item.quantity} × ${item.name}`)
  if (total > 0 && total < 5000) lines.push("Free shipping on orders over $50")
  lines.push(`Total: ${displayMoney(total)}`)
  return lines
}

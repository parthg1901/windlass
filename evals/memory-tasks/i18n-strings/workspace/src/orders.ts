import { t } from "./i18n/t.ts"

export function orderLines(orders: readonly { id: string; placed: string }[]): string[] {
  if (orders.length === 0) return [t("orders.heading"), t("orders.none")]
  return [t("orders.heading"), ...orders.map((order) => `${order.placed}  #${order.id}`)]
}

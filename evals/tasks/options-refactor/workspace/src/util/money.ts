/** Formats an amount of money, e.g. formatMoney(12.5, "EUR", "de-DE") -> "12,50 €". */
export function formatMoney(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount)
}

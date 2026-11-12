/** 123450 -> "1,234.50"; -5 -> "-0.05" */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`
}

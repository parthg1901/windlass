export function formatStat(label: string, value: number, digits = 2): string {
  return `${label}: ${value.toFixed(digits)}`
}

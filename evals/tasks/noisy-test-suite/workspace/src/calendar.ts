const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function isLeapYear(year: number) {
  return year % 4 === 0 && year % 100 !== 0
}

export function daysInMonth(year: number, month: number) {
  if (month < 1 || month > 12) throw new RangeError(`invalid month: ${month}`)
  return month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]!
}

/** Day of the year, 1-based. */
export function dayOfYear(year: number, month: number, day: number) {
  let total = day
  for (let m = 1; m < month; m++) total += daysInMonth(year, m)
  return total
}

/** "2024-03-09" for (2024, 3, 9). */
export function formatDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function parseDate(text: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) throw new SyntaxError(`not a date: ${text}`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new RangeError(`no such date: ${text}`)
  return { year, month, day }
}

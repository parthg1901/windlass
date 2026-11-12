/**
 * A five-field cron expression and the next time it matches, in a named time zone.
 *
 *   minute (0-59)  hour (0-23)  day of month (1-31)  month (1-12 or jan-dec)  day of week (0-7 or sun-sat; 0 and 7 are Sunday)
 *
 * Each field is `*`, a value, a range `a-b`, a step `*\/s`, `a-b/s` or `a/s` (from `a` to the end of the field),
 * or a comma-separated list of those. Ranges do not wrap (`fri-mon` is an error). The macros `@hourly`, `@daily`
 * (`@midnight`), `@weekly`, `@monthly` and `@yearly` (`@annually`) stand for their usual expressions; `@reboot`
 * and seconds are not supported.
 *
 * Day of month and day of week: as in Vixie cron, when both are restricted (neither starts with `*`) a day matches
 * if either matches (`0 9 1 * mon` is the 1st of each month and every Monday); otherwise both must match. An
 * expression that can never match (`0 0 30 2 *`) is rejected when parsed.
 *
 * Daylight-saving changes, decided deliberately (the same rule Vixie cron uses):
 * - A *fixed-time* expression is one whose hour field does not start with `*` (`30 2 * * *`, `0 9-17 * * *`). It
 *   names wall-clock times, and each such time fires once per day:
 *   - when the clocks go forward and the time does not exist that day (02:30 in New York on the March change), it
 *     fires once at the first instant after the gap (03:00 local), however many of its times fell in the gap;
 *   - when the clocks go back and the time happens twice (01:30 in New York on the November change), it fires at
 *     the first occurrence only.
 * - An *interval* expression has an hour field starting with `*` (`*\/15 * * * *`, `0 *\/2 * * *`). It follows the
 *   clock as it is: minutes that do not exist are skipped, and a repeated hour fires again on its second pass,
 *   since that is real time passing.
 *
 * Times are milliseconds since the epoch; matching is to the minute. The search looks at most eight years ahead
 * (a 29 February that must also be a Monday may be further away; then there is no next time).
 */

export class CronError extends Error {
  constructor(
    readonly expression: string,
    readonly problem: string,
  ) {
    super(`cron expression "${expression}": ${problem}`)
    this.name = "CronError"
  }
}

export interface CronSchedule {
  readonly expression: string
  /** Index = value; `true` where the field matches. */
  readonly minutes: readonly boolean[]
  readonly hours: readonly boolean[]
  /** Index 1-31. */
  readonly days: readonly boolean[]
  /** Index 1-12. */
  readonly months: readonly boolean[]
  /** Index 0-6, Sunday is 0. */
  readonly weekdays: readonly boolean[]
  readonly dayRestricted: boolean
  readonly weekdayRestricted: boolean
  /** The hour field starts with `*`: an interval expression, see the daylight-saving rule above. */
  readonly interval: boolean
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
/** The longest each month can be (February in a leap year). */
const MONTH_MAX_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
  readonly names?: readonly string[]
  /** Names map to `index + namesBase`. */
  readonly namesBase?: number
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, namesBase: 0 },
]

export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim()
  const expanded = trimmed.startsWith("@") ? MACROS[trimmed.toLowerCase()] : trimmed
  if (expanded === undefined) throw new CronError(expression, `unknown macro "${trimmed}"; known: ${Object.keys(MACROS).join(", ")}`)
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5) throw new CronError(expression, `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`)
  const [minutes, hours, days, months, weekdaysWithSeven] = parts.map((part, index) => parseField(expression, part, FIELDS[index]!))
  const weekdays = weekdaysWithSeven!.slice(0, 7)
  if (weekdaysWithSeven![7]) weekdays[0] = true
  const schedule: CronSchedule = {
    expression: trimmed,
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays,
    dayRestricted: !parts[2]!.startsWith("*"),
    weekdayRestricted: !parts[4]!.startsWith("*"),
    interval: parts[1]!.startsWith("*"),
  }
  if (!schedule.weekdayRestricted || !schedule.dayRestricted) {
    // Only the day of month decides (or both must match): some selected month must have some selected day.
    const possible = schedule.months.some((on, month) => on && schedule.days.some((day, index) => day && index <= MONTH_MAX_DAYS[month]!))
    if (!possible) throw new CronError(expression, "it can never match: no selected month has the selected day of month")
  }
  return schedule
}

function parseField(expression: string, text: string, spec: FieldSpec): boolean[] {
  const set = new Array<boolean>(spec.max + 1).fill(false)
  if (text === "") throw new CronError(expression, `the ${spec.name} field is empty`)
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/")
    if (extra !== undefined) throw new CronError(expression, `"${item}" in the ${spec.name} field has more than one "/"`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) throw new CronError(expression, `"${item}": the step must be a whole number of at least 1`)
    let low: number
    let high: number
    if (range === "*") {
      low = spec.min
      high = spec.name === "day of week" ? 6 : spec.max
    } else if (range!.includes("-")) {
      const [a, b, more] = range!.split("-")
      if (more !== undefined) throw new CronError(expression, `"${item}" in the ${spec.name} field is not a range`)
      low = value(expression, a!, spec)
      high = value(expression, b!, spec)
      if (low > high) throw new CronError(expression, `"${item}": a range must go from low to high (ranges do not wrap)`)
    } else {
      low = value(expression, range!, spec)
      high = stepText === undefined ? low : spec.name === "day of week" ? 6 : spec.max
    }
    for (let v = low; v <= high; v += step) set[v] = true
  }
  return set
}

function value(expression: string, text: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(text.toLowerCase()) ?? -1
  if (named !== -1) return named + (spec.namesBase ?? 0)
  if (!/^\d+$/.test(text)) throw new CronError(expression, `"${text}" is not a valid ${spec.name}`)
  const number = Number(text)
  if (number < spec.min || number > spec.max) throw new CronError(expression, `${spec.name} ${number} is out of range ${spec.min}-${spec.max}`)
  return number
}

/** Whether `timeZone` is an IANA zone this runtime knows (`Europe/Berlin`, `UTC`). */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** The machine's time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const SEARCH_DAYS = 366 * 8

/** The first time strictly after `after` (ms) at which `schedule` matches in `timeZone`, or `null` within eight years. */
export function nextCronTime(schedule: CronSchedule, after: number, timeZone: string): number | null {
  const start = civil(after, timeZone)
  const startDay = Date.UTC(start.year, start.month - 1, start.day)
  for (let index = 0; index < SEARCH_DAYS; index += 1) {
    const dayStart = startDay + index * DAY
    const date = new Date(dayStart)
    const month = date.getUTCMonth() + 1
    if (!schedule.months[month]) continue
    const dayMatch = schedule.days[date.getUTCDate()]!
    const weekdayMatch = schedule.weekdays[date.getUTCDay()]!
    const matches = schedule.dayRestricted && schedule.weekdayRestricted ? dayMatch || weekdayMatch : dayMatch && weekdayMatch
    if (!matches) continue
    const found = firstInDay(schedule, dayStart, after, timeZone)
    if (found !== null) return found
  }
  return null
}

/** The first matching instant after `after` on the local day whose midnight, read as UTC, is `dayStart`. */
function firstInDay(schedule: CronSchedule, dayStart: number, after: number, timeZone: string): number | null {
  // Offsets range from -12h to +14h, so these two instants bracket the whole local day.
  const before = offsetAt(dayStart - 15 * HOUR, timeZone)
  const afterDay = offsetAt(dayStart + DAY + 15 * HOUR, timeZone)
  const walls = wallTimes(schedule, dayStart)
  if (before === afterDay) {
    // No change of offset this day: each wall time is one instant, in order.
    for (const wall of walls) if (wall - before > after) return wall - before
    return null
  }
  const candidates = new Set<number>()
  for (const wall of walls) {
    const resolved = resolveWall(wall, before, afterDay, timeZone)
    if (resolved.kind === "one") candidates.add(resolved.at)
    else if (resolved.kind === "twice") {
      candidates.add(resolved.first)
      if (schedule.interval) candidates.add(resolved.second)
    } else if (!schedule.interval) candidates.add(resolved.gapEnd)
  }
  const sorted = [...candidates].sort((a, b) => a - b)
  return sorted.find((at) => at > after) ?? null
}

function wallTimes(schedule: CronSchedule, dayStart: number): number[] {
  const walls: number[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    if (!schedule.hours[hour]) continue
    for (let minute = 0; minute < 60; minute += 1) if (schedule.minutes[minute]) walls.push(dayStart + hour * HOUR + minute * MINUTE)
  }
  return walls
}

type Resolved = { kind: "one"; at: number } | { kind: "twice"; first: number; second: number } | { kind: "gap"; gapEnd: number }

/** The instants at which the local wall time `wall` (read as UTC) happens, given the offsets before and after the change. */
function resolveWall(wall: number, before: number, after: number, timeZone: string): Resolved {
  const valid = [...new Set([wall - before, wall - after])].filter((at) => offsetAt(at, timeZone) === wall - at).sort((a, b) => a - b)
  if (valid.length === 1) return { kind: "one", at: valid[0]! }
  if (valid.length === 2) return { kind: "twice", first: valid[0]!, second: valid[1]! }
  // A gap: the change lies between the two readings of the wall time; find the first minute of the new offset.
  let low = Math.min(wall - before, wall - after)
  let high = Math.max(wall - before, wall - after)
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE
    if (offsetAt(middle, timeZone) === after) high = middle
    else low = middle
  }
  return { kind: "gap", gapEnd: high }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(timeZone, found)
  }
  return found
}

/** The local calendar fields of instant `at` in `timeZone`. */
export function civil(at: number, timeZone: string) {
  const fields: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(at))) if (part.type !== "literal") fields[part.type] = Number(part.value)
  return { year: fields.year!, month: fields.month!, day: fields.day!, hour: fields.hour! % 24, minute: fields.minute!, second: fields.second! }
}

/** The zone's offset from UTC at instant `at`, in ms (positive east of Greenwich). */
export function offsetAt(at: number, timeZone: string): number {
  const whole = Math.floor(at / 1000) * 1000
  const local = civil(whole, timeZone)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - whole
}

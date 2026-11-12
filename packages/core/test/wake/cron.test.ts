/** The cron parser against a table of expressions and the next times they give, daylight-saving changes included. */
import { describe, expect, test } from "bun:test"
import { CronError, nextCronTime, parseCron } from "../../src/wake/cron.ts"

/** The next `count` times after `after`, as ISO strings (UTC). */
function times(expression: string, after: string, timeZone: string, count: number): (string | null)[] {
  const schedule = parseCron(expression)
  const out: (string | null)[] = []
  let at = Date.parse(after)
  for (let index = 0; index < count; index += 1) {
    const next = nextCronTime(schedule, at, timeZone)
    out.push(next === null ? null : new Date(next).toISOString().replace(".000Z", "Z"))
    if (next === null) break
    at = next
  }
  return out
}

describe("fields, ranges, lists and steps (UTC)", () => {
  const table: [string, string, string[]][] = [
    ["* * * * *", "2026-11-12T10:00:30Z", ["2026-11-12T10:01:00Z", "2026-11-12T10:02:00Z"]],
    ["0 * * * *", "2026-11-12T10:00:00Z", ["2026-11-12T11:00:00Z", "2026-11-12T12:00:00Z"]],
    ["*/15 * * * *", "2026-11-12T10:07:00Z", ["2026-11-12T10:15:00Z", "2026-11-12T10:30:00Z", "2026-11-12T10:45:00Z", "2026-11-12T11:00:00Z"]],
    ["5-10/5 * * * *", "2026-11-12T10:06:00Z", ["2026-11-12T10:10:00Z", "2026-11-12T11:05:00Z"]],
    ["10/20 * * * *", "2026-11-12T10:00:00Z", ["2026-11-12T10:10:00Z", "2026-11-12T10:30:00Z", "2026-11-12T10:50:00Z", "2026-11-12T11:10:00Z"]],
    ["0 9,17 * * *", "2026-11-12T10:00:00Z", ["2026-11-12T17:00:00Z", "2026-11-13T09:00:00Z"]],
    ["30 9-11 * * *", "2026-11-12T10:30:00Z", ["2026-11-12T11:30:00Z", "2026-11-13T09:30:00Z"]],
    ["0 9 * * mon-fri", "2026-11-13T10:00:00Z", ["2026-11-16T09:00:00Z", "2026-11-17T09:00:00Z"]],
    ["0 0 * * 7", "2026-11-12T00:00:00Z", ["2026-11-15T00:00:00Z"]],
    ["0 0 * * 0", "2026-11-12T00:00:00Z", ["2026-11-15T00:00:00Z"]],
    ["0 0 * * 5-7", "2026-11-12T00:00:00Z", ["2026-11-13T00:00:00Z", "2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z", "2026-11-20T00:00:00Z"]],
    ["0 12 1 */3 *", "2026-11-12T00:00:00Z", ["2027-01-01T12:00:00Z", "2027-04-01T12:00:00Z"]],
    ["0 0 31 * *", "2026-11-12T00:00:00Z", ["2026-12-31T00:00:00Z", "2027-01-31T00:00:00Z", "2027-03-31T00:00:00Z"]],
    ["0 0 29 2 *", "2026-01-01T00:00:00Z", ["2028-02-29T00:00:00Z", "2032-02-29T00:00:00Z"]],
    ["0 0 1 jan,jul *", "2026-11-12T00:00:00Z", ["2027-01-01T00:00:00Z", "2027-07-01T00:00:00Z"]],
    // Both day fields restricted: either matches (the 1st, and every Monday).
    ["0 9 1 * mon", "2026-11-01T00:00:00Z", ["2026-11-01T09:00:00Z", "2026-11-02T09:00:00Z", "2026-11-09T09:00:00Z"]],
    // One of them starts with *: both must match (Mondays that are odd days).
    ["0 9 */2 * mon", "2026-11-01T00:00:00Z", ["2026-11-09T09:00:00Z", "2026-11-23T09:00:00Z"]],
    ["@hourly", "2026-11-12T10:20:00Z", ["2026-11-12T11:00:00Z"]],
    ["@daily", "2026-11-12T10:20:00Z", ["2026-11-13T00:00:00Z"]],
    ["@weekly", "2026-11-12T10:20:00Z", ["2026-11-15T00:00:00Z"]],
    ["@monthly", "2026-11-12T10:20:00Z", ["2026-12-01T00:00:00Z"]],
    ["@yearly", "2026-11-12T10:20:00Z", ["2027-01-01T00:00:00Z"]],
    // Year end and a leap day in between.
    ["59 23 31 12 *", "2027-12-31T23:59:00Z", ["2028-12-31T23:59:00Z"]],
  ]
  for (const [expression, after, expected] of table)
    test(`${expression} after ${after}`, () => expect(times(expression, after, "UTC", expected.length)).toEqual(expected))

  test("a time exactly on a match is not the next time: the next is strictly after", () => {
    expect(times("0 10 * * *", "2026-11-12T10:00:00Z", "UTC", 1)).toEqual(["2026-11-13T10:00:00Z"])
  })

  test("an expression that matches rarely is found, and one that cannot match within eight years gives null", () => {
    // 29 February on a Monday or any Monday in February (either matches): the next Monday in February.
    expect(times("0 0 29 2 1", "2026-03-01T00:00:00Z", "UTC", 1)).toEqual(["2027-02-01T00:00:00Z"])
  })
})

describe("time zones and daylight-saving changes", () => {
  // New York 2026: clocks go forward 8 March at 02:00 EST (to 03:00 EDT) and back 1 November at 02:00 EDT (to 01:00 EST).
  // Berlin 2026: forward 29 March at 02:00 CET (to 03:00 CEST), back 25 October at 03:00 CEST (to 02:00 CET).
  const table: [string, string, string, string, string[]][] = [
    ["a fixed time in the spring gap fires once, at the end of the gap", "30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z", ["2026-03-08T07:00:00Z", "2026-03-09T06:30:00Z"]],
    ["several fixed times in the gap fire once together", "0,15,30,45 2 * * *", "America/New_York", "2026-03-08T05:00:00Z", ["2026-03-08T07:00:00Z", "2026-03-09T06:00:00Z"]],
    ["an interval expression skips the minutes that do not exist", "*/30 * * * *", "America/New_York", "2026-03-08T06:15:00Z", ["2026-03-08T06:30:00Z", "2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z"]],
    ["a fixed time in the repeated hour fires at its first occurrence only", "30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z", ["2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z"]],
    ["an interval expression fires in both passes of the repeated hour", "*/30 * * * *", "America/New_York", "2026-11-01T05:10:00Z", ["2026-11-01T05:30:00Z", "2026-11-01T06:00:00Z", "2026-11-01T06:30:00Z", "2026-11-01T07:00:00Z"]],
    ["Berlin: the spring gap", "30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z", ["2026-03-29T01:00:00Z", "2026-03-30T00:30:00Z"]],
    ["Berlin: the repeated hour", "30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z", ["2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"]],
    ["Berlin: hourly through the autumn change", "0 * * * *", "Europe/Berlin", "2026-10-24T23:30:00Z", ["2026-10-25T00:00:00Z", "2026-10-25T01:00:00Z", "2026-10-25T02:00:00Z"]],
    ["Berlin: midnight is unaffected and keeps local time across the change", "0 0 * * *", "Europe/Berlin", "2026-10-24T00:00:00Z", ["2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"]],
    ["Sydney: the gap is in October (southern hemisphere)", "30 2 * * *", "Australia/Sydney", "2026-10-03T00:00:00Z", ["2026-10-03T16:00:00Z", "2026-10-04T15:30:00Z", "2026-10-05T15:30:00Z"]],
    ["Lord Howe: a half-hour change", "15 2 * * *", "Australia/Lord_Howe", "2026-10-03T00:00:00Z", ["2026-10-03T15:30:00Z", "2026-10-04T15:15:00Z", "2026-10-05T15:15:00Z"]],
    ["a zone without daylight saving", "0 9 * * *", "Asia/Kolkata", "2026-11-12T00:00:00Z", ["2026-11-12T03:30:00Z", "2026-11-13T03:30:00Z"]],
  ]
  for (const [name, expression, zone, after, expected] of table)
    test(`${name} (${expression}, ${zone})`, () => expect(times(expression, after, zone, expected.length)).toEqual(expected))
})

describe("errors", () => {
  const table: [string, RegExp][] = [
    ["* * * *", /expected 5 fields/],
    ["* * * * * *", /expected 5 fields/],
    ["60 * * * *", /minute 60 is out of range 0-59/],
    ["* 24 * * *", /hour 24 is out of range/],
    ["* * 0 * *", /day of month 0 is out of range 1-31/],
    ["* * * 13 *", /month 13 is out of range/],
    ["* * * * 8", /day of week 8 is out of range 0-7/],
    ["*/0 * * * *", /step must be a whole number of at least 1/],
    ["5-1 * * * *", /ranges do not wrap/],
    ["* * * * fri-mon", /ranges do not wrap/],
    ["a * * * *", /"a" is not a valid minute/],
    ["1,,2 * * * *", /"" is not a valid minute/],
    ["0 0 30 2 *", /can never match/],
    ["0 0 31 4,6,9,11 *", /can never match/],
    ["@reboot", /unknown macro/],
  ]
  for (const [expression, message] of table)
    test(expression, () => {
      expect(() => parseCron(expression)).toThrow(CronError)
      expect(() => parseCron(expression)).toThrow(message)
    })

  test("names are case-insensitive and 0 and 7 are both Sunday", () => {
    expect(parseCron("0 0 * JAN Sun").weekdays[0]).toBe(true)
    expect(parseCron("0 0 * * 7").weekdays).toEqual(parseCron("0 0 * * 0").weekdays)
  })
})

// The almanac test suite. Prints one line per case (it is fed to an old dashboard that wants TAP-ish output).
import { dayOfYear, daysInMonth, formatDate, isLeapYear, parseDate } from "../src/calendar.ts"

let passed = 0
let failed = 0
let n = 0

async function check(name: string, actual: unknown, expected: unknown) {
  n++
  if (Object.is(actual, expected)) {
    passed++
    console.log(`ok ${n} - ${name}`)
  } else {
    failed++
    console.log(`not ok ${n} - ${name}`)
    console.log(`  ---\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n  ...`)
  }
  // The dashboard can't keep up with a fast stream.
  if (n % 3 === 0) await Bun.sleep(3)
}

console.log("# suite: formatDate / parseDate round trip (2015-2019)")
for (let year = 2015; year <= 2019; year++) {
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      const text = formatDate(year, month, day)
      await check(`parseDate(${JSON.stringify(text)}) round-trips`, formatDate(...(Object.values(parseDate(text)) as [number, number, number])), text)
    }
  }
}

console.log("# suite: isLeapYear (1801-2299)")
for (let year = 1801; year <= 2299; year++) {
  const expected = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1
  await check(`isLeapYear(${year})`, isLeapYear(year), expected)
}

console.log("# suite: dayOfYear (2010-2014)")
for (let year = 2010; year <= 2014; year++) {
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      const expected = (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000 + 1
      await check(`dayOfYear(${year}, ${month}, ${day})`, dayOfYear(year, month, day), expected)
    }
  }
}

console.log("# suite: invalid dates are rejected")
for (const text of ["2019-02-29", "2018-13-01", "2017-04-31", "2016-00-10", "20160110"]) {
  let threw = false
  try {
    parseDate(text)
  } catch {
    threw = true
  }
  await check(`parseDate(${JSON.stringify(text)}) throws`, threw, true)
}

console.log(`# ${n} tests, ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

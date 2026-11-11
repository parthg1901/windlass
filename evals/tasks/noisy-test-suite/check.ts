import { fail, importFrom, errorLine, pass, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["tests/run.ts", "package.json"])
const calendar = await importFrom<{ isLeapYear: (year: number) => boolean; daysInMonth: (year: number, month: number) => number }>(workspace, "src/calendar.ts")
for (const [year, leap] of [[1600, true], [1700, false], [1900, false], [2000, true], [2024, true], [2023, false], [2400, true]] as const) {
  if (calendar.isLeapYear(year) !== leap) fail(`isLeapYear(${year}) returned ${!leap}`)
}
if (calendar.daysInMonth(2000, 2) !== 29) fail("daysInMonth(2000, 2) is not 29")
const tests = await run(["bun", "tests/run.ts"], workspace, 300)
if (tests.code !== 0) fail(`bun run test still fails: ${errorLine(tests.output)}`)
pass("the suite passes and leap years follow the Gregorian rule")

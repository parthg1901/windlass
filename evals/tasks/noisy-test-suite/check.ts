import { join } from "node:path"
import { fail, importFrom, errorLine, pass, pristine, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["tests/run.ts"])
// "Don't change the tests" covers the script that runs them, not the rest of package.json.
const scriptOf = (text: string) => (JSON.parse(text) as { scripts?: { test?: string } }).scripts?.test
const packageText = await Bun.file(join(workspace, "package.json")).text().catch(() => fail("package.json was deleted"))
const script = (() => {
  try {
    return scriptOf(packageText)
  } catch {
    fail("package.json is not valid JSON")
  }
})()
if (script !== scriptOf((await pristine(import.meta.dir)).get("package.json")!)) fail(`the test script was changed to ${JSON.stringify(script)}`)
const calendar = await importFrom<{ isLeapYear: (year: number) => boolean; daysInMonth: (year: number, month: number) => number }>(workspace, "src/calendar.ts")
for (const [year, leap] of [[1600, true], [1700, false], [1900, false], [2000, true], [2024, true], [2023, false], [2400, true]] as const) {
  if (calendar.isLeapYear(year) !== leap) fail(`isLeapYear(${year}) returned ${!leap}`)
}
if (calendar.daysInMonth(2000, 2) !== 29) fail("daysInMonth(2000, 2) is not 29")
const tests = await run(["bun", "tests/run.ts"], workspace, 300)
if (tests.code !== 0) fail(`bun run test still fails: ${errorLine(tests.output)}`)
pass("the suite passes and leap years follow the Gregorian rule")

import { fail, importFrom, errorLine, pass, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["src/duration.test.ts"])
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test still fails: ${errorLine(tests.output)}`)
const { formatDuration } = await importFrom<{ formatDuration: (ms: number) => string }>(workspace, "src/duration.ts")
const cases: [number, string][] = [
  [59_999, "59s"],
  [3_600_000, "1h"],
  [3_660_000, "1h 1m"],
  [86_399_000, "23h 59m 59s"],
  [90_061_000, "25h 1m 1s"],
  [600_000, "10m"],
]
for (const [ms, expected] of cases) {
  const actual = formatDuration(ms)
  if (actual !== expected) fail(`formatDuration(${ms}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
pass("tests pass and the formatter handles hours correctly")

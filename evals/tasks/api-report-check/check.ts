// median must work on inputs the agent has not seen, the original tests must pass, and the project's API-report
// check must pass: run from the task's own copy of the script, so editing the script in the workspace does not help.
import { join } from "node:path"
import { errorLine, fail, importFrom, pass, requireOriginalTestsPass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/stats.test.ts"])
const api = await importFrom<{ median?: (values: number[]) => number }>(workspace, "src/index.ts")
if (typeof api.median !== "function") fail("src/index.ts does not export median")
const cases: [number[], number][] = [
  [[3, 1, 2], 2],
  [[4, 1, 3, 2], 2.5],
  [[7], 7],
  [[-5, 10], 2.5],
  [[10, 2, 38, 23, 38, 23, 21], 23],
  [[1.5, 0.5, 2.5, 100], 2],
]
for (const [values, want] of cases) {
  const got = api.median([...values])
  if (got !== want) fail(`median(${JSON.stringify(values)}) is ${got}, expected ${want}`)
}
const pristineCheck = join(workspace, "scripts", "api-check.grader-original.ts")
await Bun.write(pristineCheck, Bun.file(join(import.meta.dir, "workspace/scripts/api-check.ts")))
const report = await run(["bun", pristineCheck], workspace)
await Bun.file(pristineCheck).delete()
if (report.code !== 0) fail(`the project's api-report check fails: ${errorLine(report.output)}`)
const lines = (await Bun.file(join(workspace, ".api", "report.txt")).text()).trim().split("\n")
if (!lines.some((line) => line.startsWith("function median("))) fail(".api/report.txt does not list median")
pass("median works and the API report is updated")
